/**
 * GH#2707: the order ticket must not treat "portfolio scan still in flight" as
 * "this wallet has no account" -- no zero balance, no onboarding CTA, and no
 * account-dependent action (fund-and-trade, deposit) enabled before the answer.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  pending: vi.fn(() => false),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  initUser: vi.fn(),
  fund: vi.fn(),
  trade: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
// The pending flag is a tiny external store (like the real one), so flipping it re-renders the ticket.
const pendingStore = vi.hoisted(() => ({ listeners: new Set<() => void>(), notify() { for (const l of this.listeners) l(); } }));
vi.mock("@/hooks/useUserAccount", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (l: () => void) => { pendingStore.listeners.add(l); return () => pendingStore.listeners.delete(l); };
  return {
    useUserAccount: mocks.useUserAccount,
    useUserAccountScanPending: () => useSyncExternalStore(subscribe, () => mocks.pending()),
  };
});
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@/hooks/useInitUser", () => ({ useInitUser: () => ({ initUser: mocks.initUser, loading: false, error: null }) }));
vi.mock("@/hooks/useFirstTrade", () => ({ useFirstTrade: () => ({ fundAndTrade: mocks.fund, loading: false }) }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => null }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP", max_leverage: 10 } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({ ...(await orig<object>()), getLivePriceSnapshot: () => ({ priceUsd: 1, priceE6: 1_000_000n }) }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({
  TradeConfirmationModal: (p: { onConfirm: () => void }) => <button data-testid="confirm-trade" onClick={p.onConfirm}>confirm</button>,
}));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/trade/OrderTicketClosePanel", () => ({
  OrderTicketClosePanel: (p: { accountPending?: boolean; positionSize: bigint }) => (
    <div data-testid="close-panel" data-pending={String(!!p.accountPending)} data-size={p.positionSize.toString()} />
  ),
}));

import { OrderTicket } from "@/components/trade/OrderTicket";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");

function wallet(amount: string) {
  mocks.useConnectionCompat.mockReturnValue({
    connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount, decimals: 6 } }) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  wallet("12000000"); // 12 USDC in the wallet
  mocks.useUserAccount.mockReturnValue(null); // no trading account on this market yet
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("11111111111111111111111111111111"),
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
  mocks.fund.mockResolvedValue({ signature: "sigFirst", portfolio: new PublicKey("11111111111111111111111111111111"), prompts: 1, created: true });
});

const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;
/** UX_SHOTS_OUT: the REAL ticket markup of a state, for scripts/ux-shots/shoot-html.mjs. */
async function snap(name: string) {
  const out = process.env.UX_SHOTS_OUT;
  if (!out) return;
  const fs = await import("node:fs");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(`${out}/${name}.html`, screen.getByTestId("order-ticket").outerHTML);
}
const size = (v: string) => fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: v } });

async function place() {
  await act(async () => fireEvent.click(submit()));
  await act(async () => fireEvent.click(screen.getByTestId("confirm-trade")));
}

const ticketAvailable = () => screen.getByTestId("ticket-available").textContent ?? "";

describe("order ticket while the portfolio scan is pending (GH#2707)", () => {
  it("funded wallet, scan in flight: '—' balance, locked ticket, no fund-and-trade / onboarding / deposit actions", async () => {
    mocks.pending.mockReturnValue(true);
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    // Let the wallet ATA read land, so the pre-fix code would have switched into funding mode.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(ticketAvailable()).toMatch(/Available\s*—/);
    expect(submit().textContent).toBe("Loading account…");
    expect(submit().disabled).toBe(true);
    expect(submit().dataset.funding).toBeUndefined();
    expect(screen.queryByTestId("first-trade-line")).toBeNull();
    expect(screen.queryByTestId("deposit-submit")).toBeNull();
    expect(screen.queryByTestId("deposit-toggle")).toBeNull();
    expect(screen.queryByTestId("withdraw-toggle")).toBeNull();
    expect((screen.getByTestId("trade-size-input") as HTMLInputElement).closest("fieldset")?.disabled).toBe(true);

    await act(async () => fireEvent.click(submit()));
    expect(screen.queryByTestId("confirm-trade")).toBeNull();
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(mocks.trade).not.toHaveBeenCalled();
    expect(mocks.initUser).not.toHaveBeenCalled();
  });

  it("an order already in the form when the scan goes pending (e.g. wallet switch) cannot fund-and-trade", async () => {
    mocks.pending.mockReturnValue(false);
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("first-trade-line")).not.toBeNull());
    size("5");
    expect(submit().dataset.funding).toBe("true"); // resolved "no account": the bundled first trade is offered

    mocks.pending.mockReturnValue(true); // a new wallet/market key: its scan has not answered yet
    act(() => pendingStore.notify());
    expect(submit().dataset.funding).toBeUndefined();
    expect(submit().disabled).toBe(true);
    expect(submit().textContent).toBe("Loading account…");
    expect(screen.queryByTestId("first-trade-line")).toBeNull();
    // An order larger than the wallet (the in-market balance is unknown, not zero) must not
    // flip into a bundled deposit either, nor open the deposit card.
    size("20");
    expect(submit().dataset.funding).toBeUndefined();
    expect(submit().textContent).toBe("Loading account…");
    await act(async () => fireEvent.click(submit()));
    expect(screen.queryByTestId("confirm-trade")).toBeNull();
    expect(screen.queryByTestId("deposit-card")).toBeNull();
    expect(mocks.fund).not.toHaveBeenCalled();
  });

  it("empty wallet, scan in flight: no 'Get Tokens to Trade' onboarding CTA", async () => {
    mocks.pending.mockReturnValue(true);
    wallet("0");
    render(<OrderTicket slabAddress={SLAB} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByTestId("deposit-submit")).toBeNull();
    expect(screen.queryByText(/Get Tokens to Trade|Start Trading/i)).toBeNull();
    expect(submit().textContent).toBe("Loading account…");
    expect(submit().disabled).toBe(true);
  });

  it("Close tab, scan in flight: the close panel is told the position is not known yet", async () => {
    mocks.pending.mockReturnValue(true);
    render(<OrderTicket slabAddress={SLAB} />);
    const closeTab = screen.getAllByTestId("trade-mode-tab").find((b) => b.dataset.mode === "close")!;
    await act(async () => fireEvent.click(closeTab));
    expect(screen.getByTestId("close-panel").dataset.pending).toBe("true");
  });

  it("CONTROL: scan resolved with no account + funded wallet keeps the one-approval first trade", async () => {
    mocks.pending.mockReturnValue(false);
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("first-trade-line")).not.toBeNull());
    size("5");
    expect(submit().textContent).toBe("Deposit 5.52 USDC & Long");
    expect(submit().disabled).toBe(false);
    expect(ticketAvailable()).not.toMatch(/—/);
  });

  it("CONTROL: a known account is never shown as loading, even if the pending flag were still set", async () => {
    mocks.pending.mockReturnValue(true);
    mocks.useUserAccount.mockReturnValue({ account: { capital: 1_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 3 });
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(ticketAvailable()).toMatch(/Available 13/));
    expect(submit().textContent).not.toBe("Loading account…");
    expect(screen.getByTestId("deposit-toggle")).toBeTruthy();
  });
});
