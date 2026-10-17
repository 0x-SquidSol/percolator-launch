/**
 * The matured-stale market notice: one calm line + one button, the click is the only thing that sends, simulate first, refusals map
 * to copy, and the exit (CloseResolved) follows only when the wallet has funds. Real market bytes: CHILLHOUSE-T (see stale-resolve.test.ts).
 */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  raw: null as Uint8Array | null,
  slot: null as bigint | null,
  sendTx: vi.fn(async (_p: unknown) => "sig"),
  simulateForGate: vi.fn(async (..._a: unknown[]) => ({ consumed: 1, err: null as unknown, logs: [] as string[], rpcFailed: false, simulated: [] as unknown[] })),
  cleanup: vi.fn(async (_p: unknown) => ({ ok: true as const, closed: 1, signatures: ["s"] }) as { ok: true; closed: number; signatures: string[] } | { ok: false; reason: "progress-only" | "refused" | "others-remain"; signatures: string[] }),
  refresh: vi.fn(),
  getAccountInfo: vi.fn(),
  getSlot: vi.fn(async () => 512_136_545),
}));

const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const MINT = new PublicKey("ERe2nVetnKFH4Am7hh1cVWXd52s7uhWjorwFkU61kwan");
const WALLET = new PublicKey("HybAB3N6YCJea95BqEUU6FtwCUtrYWmmSsmN5vJGW5vf");
const SLAB = "56pWj8zYeZMv6oHHf4nwAfWAunzixxknaVNEFY48oJ2Y";

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({ raw: h.raw, programId: WRAPPER, config: { collateralMint: MINT }, refresh: h.refresh }),
}));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: { getAccountInfo: h.getAccountInfo, getSlot: h.getSlot } }),
  useWalletCompat: () => ({ publicKey: WALLET, connected: true }),
}));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => h.slot }));
// PDA derivation under jsdom's Uint8Array realm cannot find a nonce; the vault authority is not what this test is about.
vi.mock("@percolatorct/sdk", async (orig) => ({ ...(await orig<typeof import("@percolatorct/sdk")>()), deriveVaultAuthority: () => [MINT, 255] as [PublicKey, number] }));
vi.mock("@solana/spl-token", async (orig) => ({ ...(await orig<typeof import("@solana/spl-token")>()), getAssociatedTokenAddressSync: () => WALLET }));
vi.mock("@/lib/tx", () => ({ sendTx: h.sendTx, simulateForGate: h.simulateForGate }));
vi.mock("@/lib/limits/own-portfolio-cleanup", () => ({ CLEANUP_CU: 600_000, cleanupOwnPortfoliosBeforeReclaim: h.cleanup }));

import { StaleSettleNotice, StaleSettleNoticeView } from "@/components/trade/StaleSettleNotice";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { STALE_SETTLE_COPY, staleResolveStatusV22 } from "@/lib/v22/stale-resolve";

const market = (): Uint8Array =>
  new Uint8Array(Buffer.from((JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-growth/chillhouse-t.market.json"), "utf8")) as { data: string }).data, "base64"));
const SNAP = 512_136_545n;
const lastGood = staleResolveStatusV22(market(), SNAP)!.lastGoodOracleSlot;

beforeEach(() => {
  vi.clearAllMocks();
  __setDevnetV22ForTest(true);
  h.raw = market();
  h.slot = SNAP;
  h.getAccountInfo.mockResolvedValue({ data: Buffer.from(market()) });
  h.getSlot.mockResolvedValue(Number(SNAP));
  h.simulateForGate.mockResolvedValue({ consumed: 1, err: null, logs: [], rpcFailed: false, simulated: [] });
  h.cleanup.mockResolvedValue({ ok: true, closed: 1, signatures: ["s"] });
});
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

const click = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId("stale-settle-button"));
  });
};

describe("StaleSettleNoticeView", () => {
  it("one line, one button; no button without a wallet; the done line replaces the button", () => {
    const { rerender } = render(<StaleSettleNoticeView minutes={120} hasFunds busy={false} error={null} done={null} canAct onSettle={() => undefined} />);
    expect(screen.getByTestId("stale-settle-line")).toHaveTextContent("This market has had no price for over 120 minutes and can be settled. Settle it to get your funds back.");
    expect(screen.getByTestId("stale-settle-button")).toHaveTextContent("Settle market");
    rerender(<StaleSettleNoticeView minutes={120} hasFunds={false} busy={false} error={null} done={null} canAct={false} onSettle={() => undefined} />);
    expect(screen.queryByTestId("stale-settle-button")).toBeNull();
    expect(screen.getByTestId("stale-settle-line")).toHaveTextContent("and can be settled.");
    expect(screen.getByTestId("stale-settle-line")).not.toHaveTextContent("funds back");
    rerender(<StaleSettleNoticeView minutes={120} hasFunds busy={false} error={null} done={STALE_SETTLE_COPY.settled} canAct onSettle={() => undefined} />);
    expect(screen.queryByTestId("stale-settle-button")).toBeNull();
    expect(screen.getByTestId("stale-settle-done")).toBeInTheDocument();
  });
});

describe("StaleSettleNotice (hook wired)", () => {
  it("shows nothing on an unmatured market, an unknown slot, a flag-off build, or non-market bytes", () => {
    h.slot = lastGood + 150n;
    const a = render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    h.slot = null;
    const b = render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    expect(b.container).toBeEmptyDOMElement();
    b.unmount();
    h.slot = SNAP;
    __setDevnetV22ForTest(false);
    const c = render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    expect(c.container).toBeEmptyDOMElement();
    c.unmount();
    __setDevnetV22ForTest(true);
    h.raw = new Uint8Array(200);
    const d = render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    expect(d.container).toBeEmptyDOMElement();
  });

  it("matured: renders the line and NEVER sends on its own", async () => {
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    expect(screen.getByTestId("stale-settle-line").textContent).toMatch(/^This market has had no price for over \d+ minutes and can be settled\. Settle it to get your funds back\.$/);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(h.simulateForGate).not.toHaveBeenCalled();
    expect(h.cleanup).not.toHaveBeenCalled();
  });

  it("click: simulate first, then tag 39 (9 bytes, the market), then the resolved exit with this wallet's accounts", async () => {
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toHaveTextContent(STALE_SETTLE_COPY.settled));
    expect(h.simulateForGate).toHaveBeenCalledTimes(1);
    expect(h.sendTx).toHaveBeenCalledTimes(1);
    const sent = h.sendTx.mock.calls[0]![0] as { instructions: { data: Buffer; keys: { pubkey: PublicKey }[]; programId: PublicKey }[] };
    expect(sent.instructions).toHaveLength(1);
    expect(sent.instructions[0]!.data[0]).toBe(39);
    expect(sent.instructions[0]!.data.length).toBe(9);
    expect(sent.instructions[0]!.programId.equals(WRAPPER)).toBe(true);
    expect(sent.instructions[0]!.keys[0]!.pubkey.toBase58()).toBe(SLAB);
    expect(h.simulateForGate.mock.invocationCallOrder[0]).toBeLessThan(h.sendTx.mock.invocationCallOrder[0]!);
    expect(h.sendTx.mock.invocationCallOrder[0]).toBeLessThan(h.cleanup.mock.invocationCallOrder[0]!);
    const c = h.cleanup.mock.calls[0]![0] as { owner: PublicKey; market: PublicKey; collateralMint: PublicKey };
    expect(c.owner.equals(WALLET)).toBe(true);
    expect(c.market.toBase58()).toBe(SLAB);
    expect(c.collateralMint.equals(MINT)).toBe(true);
    expect(h.refresh).toHaveBeenCalled();
  });

  it("no position or capital: tag 39 only, no exit", async () => {
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds={false} canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toHaveTextContent(STALE_SETTLE_COPY.settledNoFunds));
    expect(h.sendTx).toHaveBeenCalledTimes(1);
    expect(h.cleanup).not.toHaveBeenCalled();
  });

  it.each([
    [27, STALE_SETTLE_COPY.notYet],
    [19, STALE_SETTLE_COPY.behind],
  ])("simulation refusal %i: that line, nothing sent", async (code, copy) => {
    h.simulateForGate.mockResolvedValue({ consumed: null, err: { InstructionError: [0, { Custom: code }] }, logs: [], rpcFailed: false, simulated: [] });
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-error")).toHaveTextContent(copy));
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(h.cleanup).not.toHaveBeenCalled();
  });

  it("refusal 21 (someone settled it first): skips the send and goes on to the exit", async () => {
    h.simulateForGate.mockResolvedValue({ consumed: null, err: { InstructionError: [0, { Custom: 21 }] }, logs: [], rpcFailed: false, simulated: [] });
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toBeInTheDocument());
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(h.cleanup).toHaveBeenCalledTimes(1);
  });

  it("the fresh read shows the market is no longer matured (a price landed): 27 copy, no simulation, nothing sent", async () => {
    h.getSlot.mockResolvedValue(Number(lastGood + 100n));
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-error")).toHaveTextContent(STALE_SETTLE_COPY.notYet));
    expect(h.simulateForGate).not.toHaveBeenCalled();
    expect(h.sendTx).not.toHaveBeenCalled();
  });

  it("settled but the payout is not ready (progress-only): calm line, no error", async () => {
    h.cleanup.mockResolvedValue({ ok: false, reason: "progress-only", signatures: [] });
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toHaveTextContent(STALE_SETTLE_COPY.settledPayoutSoon));
    expect(screen.queryByTestId("stale-settle-error")).toBeNull();
  });

  it("a wallet decline reads 'Cancelled', not a raw error", async () => {
    h.sendTx.mockRejectedValueOnce(new Error("User rejected the request"));
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-error")).toHaveTextContent(STALE_SETTLE_COPY.cancelled));
    expect(h.cleanup).not.toHaveBeenCalled();
  });

  it("a double click sends once", async () => {
    let release: (v: string) => void = () => undefined;
    h.sendTx.mockImplementationOnce(() => new Promise<string>((r) => { release = r; }));
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds={false} canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-button")).toBeDisabled());
    fireEvent.click(screen.getByTestId("stale-settle-button"));
    await act(async () => release("sig"));
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toBeInTheDocument());
    expect(h.sendTx).toHaveBeenCalledTimes(1);
  });
});
