/**
 * OrderTicketClosePanel (GH#2651) — the money path of the ticket's Close mode.
 *
 * Now renders the FULL close form INLINE (shared ClosePositionForm), not a
 * button that opens a modal. The panel must (a) close ONLY through
 * useClosePosition (which re-reads the on-chain size, so a stale UI size can't
 * flip/increase the position), with the slider's chosen percent, (b) apply the
 * same block gates as PositionsDock, and (c) show PnL in COLLATERAL units.
 *
 * The real ClosePositionForm is rendered (pure presentation + lib math) so the
 * assertions exercise the actual inline UI.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";

const closePosition = vi.fn();
const prewarmClose = vi.fn();
let hookState = { loading: false, error: null as string | null };
let live: { priceE6: bigint | null; priceUsd: number | null } = { priceE6: 110_000_000n, priceUsd: 110 };

vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition, prewarmClose, ...hookState }),
}));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => live }));

import { OrderTicketClosePanel, type OrderTicketClosePanelProps } from "@/components/trade/OrderTicketClosePanel";

const base = (over: Partial<OrderTicketClosePanelProps> = {}): OrderTicketClosePanelProps => ({
  slabAddress: "Slab111",
  positionSize: 1_000_000n,
  entryPriceE6: 100_000_000n,
  capital: 50_000_000n,
  symbol: "SOL",
  collateralSymbol: "USDC",
  decimals: 6,
  tradingFeeBps: 30n,
  maxFillAbs: null,
  lpUnderfunded: false,
  engineStale: false,
  oracleBlocked: false,
  onClosed: vi.fn(),
  ...over,
});

beforeEach(() => {
  cleanup();
  closePosition.mockReset();
  closePosition.mockResolvedValue({ signature: "sig" });
  prewarmClose.mockReset();
  hookState = { loading: false, error: null };
  live = { priceE6: 110_000_000n, priceUsd: 110 };
});

const closeBtn = () => screen.getByRole("button", { name: /^close \d+%$/i }) as HTMLButtonElement;

describe("OrderTicketClosePanel (inline form)", () => {
  it("shows an empty state and no close button when there is no position", () => {
    render(<OrderTicketClosePanel {...base({ positionSize: 0n })} />);
    expect(screen.getByText("No open position")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^close \d+%$/i })).toBeNull();
  });

  it("prewarms the close on mount (no click needed)", () => {
    render(<OrderTicketClosePanel {...base()} />);
    expect(prewarmClose).toHaveBeenCalledTimes(1);
  });

  it("closes through useClosePosition at the default 100%, then reports it", async () => {
    const p = base();
    render(<OrderTicketClosePanel {...p} />);
    await act(async () => fireEvent.click(closeBtn()));
    expect(closePosition).toHaveBeenCalledTimes(1);
    expect(closePosition).toHaveBeenCalledWith(100);
    expect(p.onClosed).toHaveBeenCalledWith(100);
  });

  it("respects a chosen preset percent", async () => {
    const p = base();
    render(<OrderTicketClosePanel {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    await act(async () => fireEvent.click(closeBtn()));
    expect(closePosition).toHaveBeenCalledWith(50);
    expect(p.onClosed).toHaveBeenCalledWith(50);
  });

  it("a failed close does not report success but surfaces the error", async () => {
    closePosition.mockRejectedValueOnce(new Error("boom"));
    hookState = { loading: false, error: "Could not verify current on-chain position." };
    const p = base();
    render(<OrderTicketClosePanel {...p} />);
    await act(async () => fireEvent.click(closeBtn()));
    expect(p.onClosed).not.toHaveBeenCalled();
    expect(screen.getByText("Could not verify current on-chain position.")).toBeTruthy();
  });

  it("renders a SHORT's side untouched (fresh size read happens in the hook)", () => {
    render(<OrderTicketClosePanel {...base({ positionSize: -2_000_000n })} />);
    expect(screen.getByText(/closing short position/i)).toBeTruthy();
  });

  it("disables + relabels the close button when the engine crank is behind", () => {
    render(<OrderTicketClosePanel {...base({ engineStale: true })} />);
    const btn = screen.getByRole("button", { name: /crank behind/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(closePosition).not.toHaveBeenCalled();
  });

  it("disables + relabels the close button when there is no valid mark", () => {
    live = { priceE6: null, priceUsd: null };
    render(<OrderTicketClosePanel {...base()} />);
    const btn = screen.getByRole("button", { name: /awaiting price/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(closePosition).not.toHaveBeenCalled();
  });

  it("disables the close when the LP is underfunded", () => {
    render(<OrderTicketClosePanel {...base({ lpUnderfunded: true })} />);
    expect(closeBtn().disabled).toBe(true);
    fireEvent.click(closeBtn());
    expect(closePosition).not.toHaveBeenCalled();
  });

  it("blocks the close (oracle-stale) when the oracle is blocked", () => {
    render(<OrderTicketClosePanel {...base({ oracleBlocked: true })} />);
    expect(closeBtn().disabled).toBe(true);
    expect(screen.getByText(/oracle stale/i)).toBeTruthy();
  });

  it("shows Est. PnL in collateral units (mark-to-market), not the raw native figure", () => {
    // 1 SOL long, entry $100, mark $110 -> ~ +$10. Native coin-margined ~0.09.
    render(<OrderTicketClosePanel {...base()} />);
    expect(screen.getByText(/\+9\.99\d* USDC/)).toBeTruthy();
    expect(screen.queryByText(/\+0\.09/)).toBeNull();
  });

  it("shows a loss with a minus sign", () => {
    live = { priceE6: 90_000_000n, priceUsd: 90 };
    render(<OrderTicketClosePanel {...base()} />);
    expect(screen.getByText(/-\d+\.\d+ USDC/)).toBeTruthy();
  });
});
