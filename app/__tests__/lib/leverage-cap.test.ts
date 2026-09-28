/**
 * GH#2621 — the create-market dial capped leverage at 6.5x while every layer
 * beneath it supported 10x.
 *
 * The cap comes from MIN_SAFE_INITIAL_MARGIN_BPS = 1500, a floor `create()` used
 * to apply on-chain. That floor was removed: `useCreateMarket.ts` says so in its
 * own comment ("The floor is gone"), and `market-params.ts` records WHY —
 *
 *   "The old MIN_SAFE_INITIAL_MARGIN_BPS = 1500 floor (6.67x) came from a July
 *    bisection that concluded '10x fails'. That was a MISDIAGNOSIS, re-tested
 *    2026-07-27: 10x fails only when paired with the old 1x500 budget ... With a
 *    compatible budget (4 x 100 = 400) 10x is accepted. Leverage was never the
 *    problem."
 *
 * The constant survived as an import in exactly one place — the dial — where it
 * still set the ceiling, holding creators to a limit the engine had dropped. The
 * dial also told them a protocol rule was responsible, which was not true.
 *
 * Fixed here; these are the regression pins. Each failed on 13d3d98.
 */

import { describe, expect, it } from "vitest";
import { deriveMarketParams, MAX_LEVERAGE_X, MIN_LEVERAGE_X } from "@/lib/market-params";
import { flooredInitialMarginBps, MIN_SAFE_INITIAL_MARGIN_BPS } from "@/hooks/useCreateMarket";
import { validateCreateForm } from "@/lib/createMarketValidation";
import { MAX_LEVERAGE, MIN_LEVERAGE, leverageToMarginBps, marginBpsToLeverage } from "@/components/create/StepControlRoom";

/** A valid form that differs only in its margin, so only the margin rule can fire. */
const form = (initialMarginBps: number) => ({
  mint: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
  mintValid: true,
  tokenMeta: { symbol: "PAY", name: "Pay", decimals: 6 },
  oracleResolved: true,
  oracleMode: "admin",
  tradingFeeBps: 10,
  initialMarginBps,
  lpCollateral: "1000",
  insuranceAmount: "100",
  tokenBalance: 10_000_000_000n,
  walletConnected: true,
  decimals: 6,
});

const marginErrors = (bps: number) =>
  validateCreateForm(form(bps)).filter((e) => e.field === "Initial Margin");

describe("everything below the UI supports 10x", () => {
  it("the app's own bound is 10x, and deriveMarketParams reaches it", () => {
    expect(MAX_LEVERAGE_X).toBe(10);
    const p = deriveMarketParams(10, 0n, 1_000_000n);
    expect(p.initialMarginBps).toBe(1000);
    expect(10_000 / p.initialMarginBps).toBe(10);
    // And it picks a price-move budget compatible with that maintenance margin —
    // which is the constraint the July bisection actually hit. 500 bps -> 4 is a
    // row of the on-chain-bisected table in market-params.ts.
    expect(p.maintenanceMarginBps).toBe(500);
    expect(p.maxPriceMoveBpsPerSlot).toBe(4);
  });

  it("create() applies no floor — the mirror of what lands on-chain returns 1000", () => {
    // flooredInitialMarginBps exists precisely to report the bps a request will
    // ACTUALLY be created with. If the 1500 floor were still live it would
    // return 1500 here. It returns the request unchanged.
    expect(flooredInitialMarginBps(1000)).toBe(1000);
    // CONTROL: it is not an identity function — it still clamps out of range.
    expect(flooredInitialMarginBps(100)).toBe(1000); // 100x request -> clamped to 10x
    expect(flooredInitialMarginBps(9000)).toBe(5000); // below 2x -> clamped to 2x
  });

  it("form validation accepts 1000 bps and names 10x as the limit", () => {
    expect(marginErrors(1000)).toEqual([]);
    // CONTROL: the rule exists and does reject past 10x, so the pass above is real.
    const tooLow = marginErrors(999);
    expect(tooLow).toHaveLength(1);
    expect(tooLow[0].message).toMatch(/10x max leverage/);
  });
});

describe("the dial now agrees with every layer beneath it", () => {
  it("its bounds equal the shared constants", () => {
    expect(MAX_LEVERAGE).toBe(MAX_LEVERAGE_X);
    expect(MIN_LEVERAGE).toBe(MIN_LEVERAGE_X);
  });

  // "DERIVED, not a second copy" is pinned in leverage-cap-derivation.test.ts by
  // mocking @/lib/market-params. The source-text version that used to live here
  // was defeated by a one-line local shadow and false-failed on a URL.

  it("10x is reachable and round-trips exactly", () => {
    expect(leverageToMarginBps(10)).toBe(1000);
    expect(marginBpsToLeverage(1000)).toBe(10);
    // The dial's number is the number that gets created.
    expect(flooredInitialMarginBps(leverageToMarginBps(10))).toBe(1000);
  });

  it("the removed floor is no longer applied anywhere in the converters", () => {
    // 1500 was the clamp. Any leverage above 6.67x used to collapse onto it.
    expect(Number(MIN_SAFE_INITIAL_MARGIN_BPS)).toBe(1500); // still declared, as history
    for (const lev of [7, 8, 9, 10]) {
      expect(leverageToMarginBps(lev)).toBeLessThan(1500);
    }
    // CONTROL: the converter still tracks its input rather than returning a
    // constant — otherwise the assertions above would pass on a stub.
    expect(leverageToMarginBps(2)).toBe(5000);
    expect(leverageToMarginBps(5)).toBe(2000);
  });

  it("the converters' rounding mode is pinned in both directions", () => {
    // Without these, Math.ceil snapping and Math.floor in the forward converter
    // both survived: the existing controls happened to agree with them.
    expect(leverageToMarginBps(7)).toBe(1429); // ceil/floor would give 1429/1428
    expect(leverageToMarginBps(3)).toBe(3333);
    // 1818 separates round from ceil (5.5 vs 6); 1900 separates round from
    // floor (5.5 vs 5). Both are needed — either alone leaves one mode alive.
    expect(marginBpsToLeverage(1818)).toBe(5.5);
    expect(marginBpsToLeverage(1900)).toBe(5.5);
  });

  it("all three quick-launch tiers, including the one still lossy", () => {
    // useQuickLaunch supplies 2000 / 1500 / 1000 bps by liquidity tier, and the
    // wizard normalises each through the dial. Only the 1000 tier was changed by
    // GH#2621; the other two are recorded here so a future edit cannot move them
    // silently.
    const trip = (bps: number) => leverageToMarginBps(marginBpsToLeverage(bps));
    expect(trip(2000)).toBe(2000); // 5x, exact
    expect(trip(1000)).toBe(1000); // 10x, exact — was 1538 before this change
    // NOT exact, and unchanged by this fix: 1500 is 6.667x, which is not a 0.5
    // detent, so it snaps to 6.5 and stores 1538. A real (small) gap between the
    // requested and created margin on the medium tier. Pinned, not fixed here.
    expect(trip(1500)).toBe(1538);
  });

  it("quick-launch's 10x survives the dial's quantisation", () => {
    // quick-launch supplies 1000 bps. The wizard normalises it through the dial
    // (bps -> leverage -> bps) so the displayed number matches the created one.
    // Under the floor that round-trip turned 1000 into 1538 and silently
    // downgraded every quick launch from 10x to 6.5x.
    expect(leverageToMarginBps(marginBpsToLeverage(1000))).toBe(1000);
    // CONTROL: the round-trip is still a real quantisation for off-detent values.
    expect(leverageToMarginBps(marginBpsToLeverage(1600))).toBe(1538); // 6.5x detent
  });

  it("never reports a value outside the dial's own range", () => {
    // RotaryDial does not clamp its incoming `value` prop — only commit() does —
    // so an out-of-range value paints the needle past the end of the arc and
    // renders a nonsense readout. The old 1500-bps floor guaranteed this by
    // accident (it could never return more than 6.67); removing the floor took
    // the guarantee with it, so it is now explicit.
    for (const bps of [0, -1, 1, 500, 999, 20_000, Number.NaN]) {
      const lev = marginBpsToLeverage(bps);
      expect(lev).toBeGreaterThanOrEqual(MIN_LEVERAGE);
      expect(lev).toBeLessThanOrEqual(MAX_LEVERAGE);
    }
    // CONTROL: in-range inputs are untouched by the clamp, so it has not simply
    // flattened the converter.
    expect(marginBpsToLeverage(1000)).toBe(10);
    expect(marginBpsToLeverage(2000)).toBe(5);
    expect(marginBpsToLeverage(5000)).toBe(2);
  });

  it("the engine's maximum and the dial's maximum are now the same market", () => {
    const dialBest = leverageToMarginBps(MAX_LEVERAGE);
    const engineBest = deriveMarketParams(MAX_LEVERAGE_X, 0n, 1_000_000n).initialMarginBps;
    expect(dialBest).toBe(engineBest);
    expect(10_000 / dialBest).toBe(10);
  });
});
