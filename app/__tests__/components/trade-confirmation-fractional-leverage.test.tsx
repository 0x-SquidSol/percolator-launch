/**
 * A market created at a fractional leverage cannot be traded: opening the trade
 * confirmation modal throws
 *
 *   RangeError: The number 4.5 cannot be converted to a BigInt because it is not
 *   an integer
 *
 * which the trade page's error boundary renders as "something broke in
 * OrderTicket".
 *
 * `TradeConfirmationModal.tsx` computes `margin * BigInt(leverage)` on a prop
 * typed `leverage: number`. Fractional leverage is not an edge case in this app,
 * it is the designed behaviour:
 *
 *   - `formatLeverageValue` branches on `Number.isInteger` and renders "4.5";
 *   - `OrderTicket.tsx` does the same multiplication as
 *     `BigInt(Math.round(leverage * 100)) / 100n`, with the comment
 *     "Fractional-safe (leverage may be 6.66)";
 *   - the create-market dial steps in 0.5 increments, so HALF the leverages a
 *     creator can pick are fractional.
 *
 * OrderTicket is the parent that renders this modal and passes it the same
 * `leverage` it just handled fractionally — so the fix landed on one of two
 * sibling call sites.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/hooks/useLockBodyScroll", () => ({ useLockBodyScroll: () => {} }));
vi.mock("gsap", () => ({
  default: { set: () => {}, to: () => {}, fromTo: () => {}, killTweensOf: () => {} },
}));

import { TradeConfirmationModal } from "@/components/trade/TradeConfirmationModal";
import { computeNotionalNative } from "@/lib/notional";
import { formatLeverage } from "@/lib/leverage-display";

type Props = Parameters<typeof TradeConfirmationModal>[0];

/** The 6-decimal collateral amounts a real ticket passes. */
function props(over: Partial<Props> = {}): Props {
  return {
    direction: "long",
    positionSize: 1_000_000n,
    // Deliberately not divisible by 100: a round margin hid a mutant that
    // divided before multiplying (`(margin / 100n) * ...`), which truncates.
    margin: 100_000_001n,
    leverage: 4,
    estimatedLiqPrice: 950_000n,
    tradingFee: 50_000n,
    worstFillPriceE6: 1_010_000n,
    accountEquity: 500_000_000n,
    symbol: "PAY",
    collateralSymbol: "Sim-USDC",
    decimals: 6,
    onConfirm: () => {},
    onCancel: () => {},
    ...over,
  } as Props;
}

describe("the trade confirmation modal and fractional leverage", () => {
  it("renders at a fractional leverage instead of throwing", () => {
    // 4.5x is reachable today: the create dial steps by 0.5.
    expect(() => render(<TradeConfirmationModal {...props({ leverage: 4.5 })} />)).not.toThrow();

    // And the value is shown as the user set it.
    expect(screen.getByText("4.5x")).toBeInTheDocument();
  });

  it("computes notional from the fractional leverage, not a truncated one", () => {
    // Risk leverage = notional / accountEquity. 100 margin x 4.5 = 450 over 500
    // equity = 0.9x; truncating 4.5 to 4 gives 0.8x.
    //
    // This is a COARSE check and is not the real guard: formatLeverageValue is
    // toFixed(1), so any notional in [425.1, 475.0] also prints "0.9x" — review
    // passed all of these tests with a +5.3% mutant. The exact arithmetic is
    // pinned by __tests__/lib/notional.test.ts against the shared helper; what
    // this test is for is that the modal RENDERS and wires the value through.
    render(<TradeConfirmationModal {...props({ leverage: 4.5 })} />);
    expect(screen.getByText("0.9x")).toBeInTheDocument();
  });

  it("the whole 0.5 ladder the create dial can produce is renderable", () => {
    // The dial runs 2 -> 6.5 in 0.5 steps. Half of those are fractional, so this
    // is not a rare input.
    for (let lev = 2; lev <= 6.5; lev += 0.5) {
      const { unmount } = render(<TradeConfirmationModal {...props({ leverage: lev })} />);
      // Assert something. Without this the loop was a pure smoke test: review
      // replaced the component body with `return null` for fractional leverage
      // and this still passed, because "did not throw" is all it checked.
      expect(screen.getByText(formatLeverage(lev))).toBeInTheDocument();
      unmount();
    }
  });

  it("shows the same notional OrderTicket submits", () => {
    // The gap that caused this bug: the formula existed twice, hand-copied, and
    // the fractional-safe fix reached one copy. Nothing pinned them together, so
    // nothing failed. Both now call computeNotionalNative, and this asserts the
    // modal's rendered risk leverage is derived from that shared result rather
    // than from a private re-implementation.
    const margin = 100_000_001n;
    const equity = 500_000_000n;
    for (const lev of [4.5, 6.66, 9.95]) {
      const expected = computeNotionalNative(margin, lev);
      const { unmount } = render(
        <TradeConfirmationModal {...props({ leverage: lev, margin, accountEquity: equity })} />,
      );
      expect(
        screen.getByText(formatLeverage(Number(expected) / Number(equity))),
      ).toBeInTheDocument();
      unmount();
    }
  });

  it("CONTROL: an integer leverage still works and still shows no decimal", () => {
    // Proves the harness renders the component for real, so the assertions above
    // are about fractional input rather than a modal that never mounts.
    render(<TradeConfirmationModal {...props({ leverage: 4 })} />);
    expect(screen.getByText("4x")).toBeInTheDocument();
    expect(screen.getByText("0.8x")).toBeInTheDocument();
  });
});
