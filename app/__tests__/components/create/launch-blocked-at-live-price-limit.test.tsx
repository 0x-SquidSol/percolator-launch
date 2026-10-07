/**
 * #3320: a wallet already at its per-creator live-price ceiling can't start a new keeper-priced
 * launch: it would be refused registration for good and sit with no live price, after spending its
 * rent, LP and insurance. Only a KNOWN limit blocks; continuing a started launch never does.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StepControlRoom } from "@/components/create/StepControlRoom";
import { blocksNewLaunch, parseCapacity } from "@/hooks/useLivePriceCapacity";
import { LIVE_PRICE_LIMIT_COPY } from "@/lib/wizard-copy";

const atLimit = parseCapacity({ activeSlabs: Array.from({ length: 10 }, (_, i) => `S${i}`), max: 10, atLimit: true });
const below = parseCapacity({ activeSlabs: ["S0"], max: 10, atLimit: false });
const unknown = parseCapacity(null);

describe("blocksNewLaunch", () => {
  it("blocks a new keeper-priced launch at a known limit", () => {
    expect(blocksNewLaunch(atLimit, { keeperPriced: true, resuming: false })).toBe(true);
  });
  it("never blocks below the limit, on an unknown read, a non-keeper market, or a launch being continued", () => {
    expect(blocksNewLaunch(below, { keeperPriced: true, resuming: false })).toBe(false);
    expect(blocksNewLaunch(unknown, { keeperPriced: true, resuming: false })).toBe(false);
    expect(blocksNewLaunch(atLimit, { keeperPriced: false, resuming: false })).toBe(false);
    expect(blocksNewLaunch(atLimit, { keeperPriced: true, resuming: true })).toBe(false);
  });
});

describe("the Control Room shows the reason on the disabled launch button", () => {
  it("names the limit and what to do, without a banned term", () => {
    const reason = LIVE_PRICE_LIMIT_COPY(10);
    render(
      <StepControlRoom
        {...({
          symbol: "TEST", oracleLabel: "Keeper (Pump.fun)", startPrice: "$0.004869", slabBytes: 26508, rentSol: 0.185,
          initialMarginBps: 1000, tradingFeeBps: 30, lpCollateral: "1000", insuranceAmount: "100", collateralSymbol: "USDC",
          seedTotal: 3100, seedBacking: 2000, onMarginBpsChange: vi.fn(), onLpCollateralChange: vi.fn(), onInsuranceChange: vi.fn(),
          onLaunch: vi.fn(), onBack: vi.fn(), registrable: true, launchDisabled: true, launchDisabledReason: reason,
        } as never)}
      />,
    );
    expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
    expect(reason).toContain("10 live-priced markets");
    expect(reason).not.toMatch(/maintainer|keeper|slab/i);
  });
});
