/**
 * OrderTicketClosePanel (GH#2651) — the money path of the ticket's Close mode.
 *
 * The panel must (a) close ONLY through useClosePosition (which re-reads the
 * on-chain size, so a stale UI size cannot flip/increase the position), (b) hand
 * the ClosePositionModal the position's own signed size and side untouched, (c)
 * apply the same block gates as PositionsDock, and (d) show PnL in COLLATERAL
 * units, not the raw native on-chain figure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";

const closePosition = vi.fn();
const prewarmClose = vi.fn();
let hookState = { loading: false, error: null as string | null };
let live: { priceE6: bigint | null; priceUsd: number | null } = { priceE6: 110_000_000n, priceUsd: 110 };
let lastModalProps: Record<string, unknown> | null = null;

vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition, prewarmClose, ...hookState }),
}));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => live }));
vi.mock("@/components/trade/ClosePositionModal", () => ({
  ClosePositionModal: (props: Record<string, unknown> & { onConfirm: (p: number) => void; onCancel: () => void }) => {
    lastModalProps = props;
    return (
      <div data-testid="modal">
        <button onClick={() => props.onConfirm(50)}>confirm50</button>
        <button onClick={() => props.onConfirm(100)}>confirm100</button>
      </div>
    );
  },
}));

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
  lastModalProps = null;
});

const open = () => fireEvent.click(screen.getByRole("button", { name: /close position/i }));

describe("OrderTicketClosePanel", () => {
  it("shows an empty state and no close button when there is no position", () => {
    render(<OrderTicketClosePanel {...base({ positionSize: 0n })} />);
    expect(screen.getByText("No open position")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /close position/i })).toBeNull();
  });

  it("closes only through useClosePosition, with the chosen percent, then reports it", async () => {
    const p = base();
    render(<OrderTicketClosePanel {...p} />);
    open();
    expect(prewarmClose).toHaveBeenCalledTimes(1);
    expect(closePosition).not.toHaveBeenCalled(); // opening the modal closes nothing
    await act(async () => fireEvent.click(screen.getByText("confirm50")));
    expect(closePosition).toHaveBeenCalledTimes(1);
    expect(closePosition).toHaveBeenCalledWith(50);
    expect(p.onClosed).toHaveBeenCalledWith(50);
    expect(screen.queryByTestId("modal")).toBeNull();
  });

  it("reports a full close as 100 (so the caller clears the entry cache)", async () => {
    const p = base();
    render(<OrderTicketClosePanel {...p} />);
    open();
    await act(async () => fireEvent.click(screen.getByText("confirm100")));
    expect(p.onClosed).toHaveBeenCalledWith(100);
  });

  it("a failed close keeps the modal open and does not report success", async () => {
    closePosition.mockRejectedValueOnce(new Error("boom"));
    const p = base();
    render(<OrderTicketClosePanel {...p} />);
    open();
    await act(async () => fireEvent.click(screen.getByText("confirm50")));
    expect(p.onClosed).not.toHaveBeenCalled();
    expect(screen.getByTestId("modal")).toBeTruthy();
  });

  it("passes a SHORT's negative size and side through untouched (no flip)", () => {
    render(<OrderTicketClosePanel {...base({ positionSize: -2_000_000n })} />);
    expect(screen.getByText(/short position/i)).toBeTruthy();
    open();
    expect(lastModalProps?.positionSize).toBe(-2_000_000n);
    expect(lastModalProps?.isLong).toBe(false);
  });

  it("passes a LONG's size and side, and surfaces the hook error into the modal", () => {
    hookState = { loading: false, error: "Could not verify current on-chain position." };
    render(<OrderTicketClosePanel {...base()} />);
    open();
    expect(lastModalProps?.positionSize).toBe(1_000_000n);
    expect(lastModalProps?.isLong).toBe(true);
    expect(lastModalProps?.error).toBe("Could not verify current on-chain position.");
  });

  it.each([
    ["engine stale (crank behind)", { engineStale: true }, /crank behind/i],
    ["LP underfunded", { lpUnderfunded: true }, /close position/i],
  ] as const)("disables Close when %s", (_n, over, label) => {
    render(<OrderTicketClosePanel {...base(over)} />);
    const btn = screen.getByRole("button", { name: label }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(screen.queryByTestId("modal")).toBeNull();
    expect(prewarmClose).not.toHaveBeenCalled();
  });

  it("disables Close until a valid mark exists", () => {
    live = { priceE6: null, priceUsd: null };
    render(<OrderTicketClosePanel {...base()} />);
    expect((screen.getByRole("button", { name: /awaiting price/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocks Confirm in the modal when the oracle is blocked or the engine goes stale", () => {
    render(<OrderTicketClosePanel {...base({ oracleBlocked: true })} />);
    open();
    expect(lastModalProps?.oracleStale).toBe(true);
  });

  it("shows PnL in collateral units (mark-to-market), not the raw native figure", () => {
    // 1 SOL long, entry $100, mark $110 -> ~ +$10. The native coin-margined
    // number is ~0.09, which is what raw account.pnl would have shown.
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
