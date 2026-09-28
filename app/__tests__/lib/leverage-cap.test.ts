/**
 * GH#2621 — the create-market dial's leverage ceiling.
 *
 * The dial used to cap at 6.5x, floored via the OLD MIN_SAFE_INITIAL_MARGIN_BPS
 * (1500 bps), and told creators that cap was "the protocol's 15% margin floor".
 * That floor was removed 2026-07-27 (see useCreateMarket.ts's
 * MIN_SAFE_INITIAL_MARGIN_BPS comment and market-params.ts's
 * MAX_PRICE_MOVE_BY_MARGIN table): it came from a bisection that mis-blamed
 * leverage for a failure actually caused by an incompatible price-move budget.
 *
 * Every layer below the dial already supports MAX_LEVERAGE_X (10x):
 *   - deriveMarketParams(10) -> 1000 bps / 500 maintenance / maxPriceMove 4,
 *     the exact row MAX_PRICE_MOVE_BY_MARGIN bisected against the deployed
 *     program for 10x;
 *   - flooredInitialMarginBps(1000) === 1000 — no floor kicks in;
 *   - createMarketValidation.ts accepts 1000 bps and rejects only below it;
 *   - the deployed wrapper's handle_init_market (percolator-prog
 *     v16_program.rs, verified against the v18.1 deploy candidate,
 *     ~/deploycand-v181/percolator-prog @3262608b) assigns initial_margin_bps
 *     straight to cfg with no bound of its own — the only real ceiling is the
 *     solvency envelope (validate_exact_solvency_envelope in
 *     ~/deploycand-v181/percolator @35ddd692's src/v16.rs), which is a
 *     function of maintenance margin and the price-move budget, not leverage.
 *
 * The dial was the only thing still enforcing the dead 6.5x floor.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_LEVERAGE,
  MIN_LEVERAGE,
  leverageToMarginBps,
  marginBpsToLeverage,
} from "@/components/create/StepControlRoom";
import { deriveMarketParams, MAX_LEVERAGE_X } from "@/lib/market-params";
import { flooredInitialMarginBps } from "@/hooks/useCreateMarket";
import { validateCreateForm, type CreateFormValues } from "@/lib/createMarketValidation";

const BASE_FORM: CreateFormValues = {
  mint: "So11111111111111111111111111111111111111112",
  mintValid: true,
  tokenMeta: { symbol: "SOL", name: "Solana", decimals: 9 },
  oracleResolved: true,
  oracleMode: "auto",
  tradingFeeBps: 30,
  initialMarginBps: 1000,
  lpCollateral: "1000",
  insuranceAmount: "100",
  tokenBalance: 10_000_000_000n,
  walletConnected: true,
  decimals: 9,
};

const LP = 1_000_000_000n; // 1,000 units at 6dp
const PRICE_E6 = 1_000_000n;

describe("GH#2621 — the dial's leverage ceiling matches the real protocol bound", () => {
  it("the dial's max is MAX_LEVERAGE_X (10x), not the dead 6.5x floor", () => {
    expect(MAX_LEVERAGE).toBe(MAX_LEVERAGE_X);
    expect(MAX_LEVERAGE).toBe(10);
    // CONTROL: this is a real change, not a renamed constant that still holds 6.5.
    expect(MAX_LEVERAGE).not.toBe(6.5);
  });

  it("the dial's min is unchanged (2x) — this fix only raises the ceiling", () => {
    expect(MIN_LEVERAGE).toBe(2);
  });

  it("asking the dial for its own maximum hands back what the pipeline accepts", () => {
    // This was the gap: asking for the dial's old maximum (6.5x) produced 1538
    // bps, while the pipeline would have accepted 1000 bps (10x) for the same
    // request. Now the dial's own ceiling round-trips to exactly what
    // deriveMarketParams derives for 10x.
    const bps = leverageToMarginBps(MAX_LEVERAGE);
    expect(bps).toBe(1000);
    expect(bps).toBe(deriveMarketParams(10, LP, PRICE_E6).initialMarginBps);
  });

  it("flooredInitialMarginBps does not clamp the dial's maximum — no floor kicks in", () => {
    const bps = leverageToMarginBps(MAX_LEVERAGE);
    expect(flooredInitialMarginBps(bps)).toBe(bps);
  });

  it("createMarketValidation accepts the dial's maximum outright — no error", () => {
    const bps = leverageToMarginBps(MAX_LEVERAGE);
    const errors = validateCreateForm({ ...BASE_FORM, initialMarginBps: bps });
    expect(errors.find((e) => e.field === "Initial Margin")).toBeUndefined();
  });

  it("marginBpsToLeverage no longer clamps a sub-1500-bps value down to 6.5x", () => {
    // Before this fix, marginBpsToLeverage floored `bps` at the dead 1500,
    // so 1000 bps (a real 10x request) displayed as 6.5x. Now it round-trips
    // exactly.
    expect(marginBpsToLeverage(1000)).toBe(10);
    // CONTROL: values that were never near the old floor are unaffected.
    expect(marginBpsToLeverage(5000)).toBe(2);
    expect(marginBpsToLeverage(2500)).toBe(4);
  });

  it("leverageToMarginBps(10) is 1000 bps, not the old floor's 1500", () => {
    expect(leverageToMarginBps(10)).toBe(1000);
    // CONTROL: distinguishes a real fix from a no-op that still floors.
    expect(leverageToMarginBps(10)).not.toBe(1500);
  });

  it("every rung of the extended 0.5 ladder (2x -> 10x) round-trips exactly", () => {
    for (let lev = MIN_LEVERAGE; lev <= MAX_LEVERAGE; lev += 0.5) {
      const bps = leverageToMarginBps(lev);
      expect(marginBpsToLeverage(bps)).toBe(lev);
    }
  });

  it("never reports a value outside the dial's own range (#2625)", () => {
    // RotaryDial does not clamp its incoming `value` prop, and the wizard restores
    // initialMarginBps from localStorage unsanitised.
    for (const bps of [0, -1, 1, 500, 999, 20_000, Number.NaN]) {
      const lev = marginBpsToLeverage(bps);
      expect(lev).toBeGreaterThanOrEqual(MIN_LEVERAGE);
      expect(lev).toBeLessThanOrEqual(MAX_LEVERAGE);
    }
    // CONTROL: in-range inputs are untouched by the clamp.
    expect(marginBpsToLeverage(1000)).toBe(10);
    expect(marginBpsToLeverage(2000)).toBe(5);
  });
});
