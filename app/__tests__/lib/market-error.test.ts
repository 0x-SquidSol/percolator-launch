// @vitest-environment node
/**
 * P0b error mapping: a LOCKED market vs a genuinely UNAUTHORIZED action vs a
 * LOCKED / unauthorising WALLET, across the error shapes Phantom, Solflare and
 * our own presimulation produce. Plus health-aware refinement of 19/21/49.
 */
import { describe, it, expect } from "vitest";
import { detectWalletError, failingProgramId, humanizeError, WALLET_LOCKED_MESSAGE, extractErrorCode } from "@/lib/errorMessages";
import {
  explainMarketTxError,
  MSG_BANKRUPTCY,
  MSG_LOSS_STALE,
  MSG_LP_DEPLETED_OPEN,
  MSG_REPAIRABLE,
  MSG_RESOLVED,
} from "@/lib/market-error";
import { extractTxErrorMessage } from "@/lib/tx";
import type { MarketHealthRow, LockReason } from "@/lib/market-health";

const WRAPPER = "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ";
const MATCHER = "4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT";

// ── Shapes ──────────────────────────────────────────────────────────────────
/** Our presimulateOrThrow (both wallets on devnet: we sign-then-submit). */
const presim = (idx: number, code: number, program = WRAPPER) =>
  `Transaction simulation failed: {"InstructionError":[${idx},{"Custom":${code}}]}\n` +
  `Program ${program} failed: custom program error: 0x${code.toString(16)}`;
/** Solflare / RPC preflight string. */
const solflare = (idx: number, code: number, program = WRAPPER) =>
  `failed to send transaction: Transaction simulation failed: Error processing Instruction ${idx}: custom program error: 0x${code.toString(16)}\n` +
  `Program ${program} failed: custom program error: 0x${code.toString(16)}`;
/** Phantom via Privy: generic wrapper with the detail in cause.logs. */
const phantomWrapped = (code: number, program = WRAPPER): string => {
  const err = new Error("Unexpected error") as Error & { cause?: unknown };
  err.cause = { logs: [`Program log: Instruction: TradeCpi`, `Program ${program} failed: custom program error: 0x${code.toString(16)}`] };
  return extractTxErrorMessage(err);
};
const PHANTOM_LOCKED = JSON.stringify({ code: 4100, message: "The requested method and/or account has not been authorized by the user." });
const PHANTOM_REJECTED = JSON.stringify({ code: 4001, message: "User rejected the request." });
const SOLFLARE_LOCKED = "WalletSignTransactionError: Wallet is locked";
const ADAPTER_NOT_CONNECTED = "WalletNotConnectedError: Wallet not connected";

const health = (over: Partial<MarketHealthRow> & { lockReasons?: LockReason[] } = {}): MarketHealthRow => ({
  lpCapital: "1000",
  lpDepleted: false,
  payoutHaircutBps: 0,
  openProfitAtoms: "0",
  realizableProfitAtoms: "0",
  lockReasons: [],
  badges: [],
  ...over,
});

describe("wallet-side refusals are not program errors", () => {
  for (const [name, raw] of [
    ["Phantom 4100", PHANTOM_LOCKED],
    ["Solflare locked", SOLFLARE_LOCKED],
    ["adapter not connected", ADAPTER_NOT_CONNECTED],
  ] as const) {
    it(`${name} → wallet locked message (never 'Not authorized')`, () => {
      expect(detectWalletError(raw)).toBe("locked");
      expect(humanizeError(raw)).toBe(WALLET_LOCKED_MESSAGE);
      expect(humanizeError(raw, "trade")).not.toMatch(/Not authorized/);
      expect(explainMarketTxError(raw, "open", health({ lpDepleted: true }))).toBeNull();
    });
  }
  it("Phantom 4001 → cancelled", () => {
    expect(detectWalletError(PHANTOM_REJECTED)).toBe("rejected");
    expect(humanizeError(PHANTOM_REJECTED)).toBe("Transaction cancelled.");
  });
  it("NEGATIVE CONTROL: a program error is not mistaken for a wallet error", () => {
    expect(detectWalletError(presim(3, 21))).toBeNull();
    expect(detectWalletError(solflare(3, 8))).toBeNull();
  });
});

describe("program Unauthorized(8) vs market locked(21), every wallet shape", () => {
  for (const [shape, make] of [
    ["presim", (c: number) => presim(4, c)],
    ["solflare", (c: number) => solflare(4, c)],
    ["phantom", (c: number) => phantomWrapped(c)],
  ] as const) {
    it(`${shape}: 8 says not authorized, 21 says locked`, () => {
      expect(extractErrorCode(make(8))).toBe(8);
      expect(humanizeError(make(8), "trade")).toMatch(/^Not authorized/);
      expect(humanizeError(make(21), "trade")).toMatch(/locked/i);
      expect(humanizeError(make(21), "trade")).not.toMatch(/Not authorized/);
    });
    it(`${shape}: Unauthorized(8) is NEVER refined into a lock, even on a locked market`, () => {
      const locked = health({ lpDepleted: true, lockReasons: ["resolved", "bankruptcy", "repairable"] });
      expect(explainMarketTxError(make(8), "open", locked)).toBeNull();
    });
  }
});

describe("code overlap routed by the failing program", () => {
  it("first failing program line wins (CPI callee is logged first)", () => {
    const raw = `Program ${MATCHER} failed: custom program error: 0x15\nProgram ${WRAPPER} failed: custom program error: 0x15`;
    expect(failingProgramId(raw)).toBe(MATCHER);
  });
  it("matcher Custom(21) is reported as a matcher rejection, not 'market locked'", () => {
    const raw = `Transaction simulation failed\nProgram ${MATCHER} failed: custom program error: 0x15\nProgram ${WRAPPER} failed: custom program error: 0x15`;
    expect(humanizeError(raw, "trade")).toMatch(/matcher rejected this fill \(matcher error 21\)/);
    expect(explainMarketTxError(raw, "open", health({ lockReasons: ["bankruptcy"] }))).toBeNull();
  });
  it("NEGATIVE CONTROL: the wrapper's own 21 still maps to the wrapper text", () => {
    expect(humanizeError(presim(4, 21), "trade")).toMatch(/temporarily locked/);
  });
});

describe("explainMarketTxError: 19/21/49 refined by live health", () => {
  it("LP depleted: open Custom(49) and Custom(21) → LP depleted (live COLLECT/TEXTIT/Murphy)", () => {
    const h = health({ lpDepleted: true, lpCapital: "0" });
    expect(explainMarketTxError(presim(4, 49), "open", h)).toBe(MSG_LP_DEPLETED_OPEN);
    expect(explainMarketTxError(solflare(4, 21), "open", h)).toBe(MSG_LP_DEPLETED_OPEN);
    expect(explainMarketTxError(phantomWrapped(49), "open", h)).toBe(MSG_LP_DEPLETED_OPEN);
  });
  it("NEGATIVE CONTROL: Custom(49) with a funded LP stays the user-margin message; a close is never 'LP depleted'", () => {
    expect(explainMarketTxError(presim(4, 49), "open", health())).toBeNull();
    expect(humanizeError(presim(4, 49))).toMatch(/Insufficient margin/);
    expect(explainMarketTxError(presim(4, 49), "close", health({ lpDepleted: true }))).toBeNull();
  });
  it("resolved / bankruptcy / repairable / loss-stale", () => {
    expect(explainMarketTxError(presim(4, 21), "open", health({ lockReasons: ["resolved"] }))).toBe(MSG_RESOLVED);
    expect(explainMarketTxError(presim(4, 21), "open", health({ lockReasons: ["bankruptcy"] }))).toBe(MSG_BANKRUPTCY);
    expect(explainMarketTxError(presim(4, 19), "close", health({ lockReasons: ["repairable"] }))).toBe(MSG_REPAIRABLE);
    expect(explainMarketTxError(presim(4, 21), "deposit", health({ lockReasons: ["loss-stale"] }))).toBe(MSG_LOSS_STALE);
  });
  it("NEGATIVE CONTROL: no health / healthy market / unrelated code → keep the generic text", () => {
    expect(explainMarketTxError(presim(4, 21), "open", null)).toBeNull();
    expect(explainMarketTxError(presim(4, 21), "open", health())).toBeNull();
    expect(explainMarketTxError(presim(4, 27), "open", health({ lpDepleted: true }))).toBeNull();
    expect(explainMarketTxError("Blockhash not found", "open", health({ lpDepleted: true }))).toBeNull();
  });
});
