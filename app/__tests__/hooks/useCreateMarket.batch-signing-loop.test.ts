/**
 * "Creating market keeps asking me to sign, never ends" (live report, 2026-10-02).
 *
 * The batched launch signs every tx up front against ONE blockhash (~60-90s). A wallet that
 * approves one tx at a time (no signAllTransactions / Privy's per-tx fallback) takes longer than
 * that at human pace, the first send is rejected as expired, and recoverTailFrom re-prompted the
 * whole remainder, which expired the same way: 7 + 6 + 6 prompts, launch failed.
 * Reproduced on devnet with the real hook: __tests__/live/create-market-live.test.tsx.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  sendTx: vi.fn(),
  connection: null as unknown as Record<string, unknown>,
  wallet: null as unknown as Record<string, unknown>,
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: mocks.connection }),
  useWalletCompat: () => mocks.wallet,
}));
vi.mock("@/lib/config", async (orig) => {
  const real = await orig<typeof import("@/lib/config")>();
  return {
    ...real,
    getConfig: () => ({
      ...(real.getConfig() as Record<string, unknown>),
      programId: "69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9",
      matcherProgramId: "4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT",
    }),
  };
});
vi.mock("@percolatorct/sdk", async (orig) => {
  const real = await orig<typeof import("@percolatorct/sdk")>();
  // The sequential path starts deriving PDAs; this test stops it at its first send.
  return { ...real, deriveVaultAuthority: () => [new PublicKey(new Uint8Array(32).fill(23)), 255] };
});
vi.mock("@/lib/tx", async (orig) => ({ ...(await orig<typeof import("@/lib/tx")>()), sendTx: mocks.sendTx }));
vi.mock("@/lib/inFlightMarket", () => ({
  saveInFlightMarket: vi.fn(),
  updateInFlightStep: vi.fn(),
  clearInFlightMarket: vi.fn(),
  loadLastInFlightMarket: vi.fn(() => null),
}));

import {
  useCreateMarket,
  expiredBlockhashAction,
  SLOW_BATCH_SIGN_MS,
  NO_BATCH_SIGNING_REASON,
} from "@/hooks/useCreateMarket";

describe("expiredBlockhashAction (pure policy)", () => {
  it("re-signs the batch when signing was quick", () => {
    expect(expiredBlockhashAction({ tailIdx: 0, lastSignMs: 2_000, recoveriesUsed: 0 })).toBe("resign-batch");
    expect(expiredBlockhashAction({ tailIdx: 3, lastSignMs: SLOW_BATCH_SIGN_MS - 1, recoveriesUsed: 1 })).toBe("resign-batch");
  });
  it("falls back to the sequential path when signing was slow and nothing has landed", () => {
    expect(expiredBlockhashAction({ tailIdx: 0, lastSignMs: SLOW_BATCH_SIGN_MS, recoveriesUsed: 0 })).toBe("sequential-fallback");
    expect(expiredBlockhashAction({ tailIdx: 0, lastSignMs: 105_000, recoveriesUsed: 0 })).toBe("sequential-fallback");
  });
  it("never re-prompts a slow signer once part of the launch has landed", () => {
    expect(expiredBlockhashAction({ tailIdx: 2, lastSignMs: 60_000, recoveriesUsed: 0 })).toBe("give-up");
  });
  it("keeps the recovery cap", () => {
    expect(expiredBlockhashAction({ tailIdx: 0, lastSignMs: 1_000, recoveriesUsed: 2 })).toBe("give-up");
  });
});

describe("create(): wallet without signAllTransactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const kp = Keypair.generate();
    mocks.connection = {
      getAccountInfo: vi.fn(async () => null),
      getMinimumBalanceForRentExemption: vi.fn(async () => 1_000_000),
      getBalance: vi.fn(async () => 5_000_000_000),
    };
    mocks.wallet = {
      publicKey: kp.publicKey,
      connected: true,
      connecting: false,
      signTransaction: vi.fn(async (tx) => tx),
      signAllTransactions: undefined,
      signMessage: undefined,
      disconnect: vi.fn(),
    };
    // Stop the sequential path at its first send; this test is about what happens BEFORE it.
    mocks.sendTx.mockRejectedValue(new Error("stop: sequential path reached"));
  });

  it("skips the up-front batch (no 7-prompt pre-sign against one blockhash) and records why", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const { result } = renderHook(() => useCreateMarket());
    await act(async () => {
      await result.current.create({
        mint: new PublicKey(Keypair.generate().publicKey),
        initialPriceE6: 100_000n,
        lpCollateral: 1_000_000_000n,
        insuranceAmount: 100_000_000n,
        oracleFeed: "0".repeat(64),
        invert: false,
        tradingFeeBps: 10,
        initialMarginBps: 1_000,
        decimals: 6,
        symbol: "T",
        name: "T",
        oracleMode: "admin",
      });
    });
    expect(result.current.state.batchFallbackReason).toBe(NO_BATCH_SIGNING_REASON);
    // The batch pre-signs through wallet.signTransaction N times; none of that may happen.
    expect((mocks.wallet.signTransaction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    fetchSpy.mockRestore();
  });
});
