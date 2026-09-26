/**
 * Margin health — the risk number that still exists when the liquidation
 * price doesn't.
 *
 * Percolator is cross-margin: everything deposited into a market's portfolio
 * backs every position in it. A consequence is that `computeLiqPrice` clamps a
 * long's liquidation price to `0n` once collateral exceeds roughly
 * `notional * (1 + mm)` — the position genuinely cannot be liquidated by
 * price, so there is no price to show. Correct, and useless as a risk signal:
 * the surfaces that lead with a liquidation price then have nothing to say
 * precisely when the trader asks "how close am I?".
 *
 * Margin health is `capital / notional`, and it is defined whenever there is a
 * position and a mark. It needs no entry price and no liquidation price, so it
 * survives every case that makes the liquidation price unavailable. The two are
 * the same fact expressed differently:
 *
 *      health >= (10000 + mm) / 100 %      <=>      no liquidation price
 *
 * At mm = 500 that is 105%. Below it a liquidation price exists and the usual
 * distance-based colouring applies; at or above it, the position is covered at
 * any price. Surfacing the number lets the UI say which side of that line the
 * trader is on instead of rendering a dash.
 *
 * This is the shape other cross-margin venues lead with — a margin ratio or
 * account-health figure, with the liquidation price secondary — because a
 * per-position liquidation price is an isolated-margin concept that does not
 * always exist here.
 *
 * Extracted from PositionPanel.tsx, which was the only surface computing it.
 */

/**
 * NOMINAL size, deliberately.
 *
 * ADL scales an asset's shared per-side factor without rewriting the leg's
 * basis, so a deleveraged position carries less *exposure* than its nominal
 * size. Margin and closing are denominated in the nominal basis, and using the
 * reduced exposure as the denominator would shrink it and render a
 * deleveraged position as SAFER than it is — the one direction a risk
 * indicator must never fail in. PositionPanel's own comment says the same
 * thing about the notional it feeds this.
 */
/**
 * Coerce to bigint without throwing.
 *
 * These arrive from parsed on-chain state and are typed bigint, but this feeds
 * a RISK readout rendered during paint: one mistyped caller raising
 * "Cannot mix BigInt and other types" blanks the entire position row rather
 * than degrading a single figure. Returning null and showing nothing is the
 * correct failure, and #2556 is why null must never become a number here.
 */
function toBig(v: bigint | number | null | undefined): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  return null;
}

export function computeMarginHealthPct(
  capital: bigint | number | null | undefined,
  nominalPositionSize: bigint | number | null | undefined,
  markPriceE6: bigint | number | null | undefined,
): number | null {
  const cap = toBig(capital);
  const size = toBig(nominalPositionSize);
  const mark = toBig(markPriceE6);
  if (cap == null || size == null || mark == null) return null;

  const absNominal = size < 0n ? -size : size;
  if (absNominal === 0n || mark <= 0n) return null;
  const notionalE6 = absNominal * mark;
  if (notionalE6 <= 0n) return null;
  // capital is collateral atoms (e6); notionalE6 is size(e6) * price(e6).
  return Number((cap * 1_000_000n * 100n) / notionalE6);
}

/**
 * The health percentage at or above which a long has no liquidation price.
 * `(10000 + maintenanceMarginBps) / 100` — 105% at the default 5%.
 */
export function unliquidatableHealthThresholdPct(
  // Accepts a number as well as a bigint on purpose. The declared type is
  // bigint, but this feeds a RISK readout rendered during paint: a
  // "Cannot mix BigInt and other types" throw from one mistyped caller would
  // blank the whole position row rather than degrade one figure. Normalising
  // is cheaper than that failure mode.
  maintenanceMarginBps: bigint | number,
): number {
  const mm = Number(maintenanceMarginBps);
  if (!Number.isFinite(mm) || mm < 0) return 100;
  return (10_000 + mm) / 100;
}

/**
 * Severity bands for the health figure, aligned with the liquidation-price
 * threshold rather than invented: at or above the threshold there is no
 * liquidation price at all, and below it the position is closer to the line
 * the lower the number goes.
 */
export type MarginHealthBand = "covered" | "safe" | "warning" | "danger";

export function marginHealthBand(
  healthPct: number | null,
  maintenanceMarginBps: bigint | number,
): MarginHealthBand | null {
  if (healthPct == null || !Number.isFinite(healthPct)) return null;
  const threshold = unliquidatableHealthThresholdPct(maintenanceMarginBps);
  if (healthPct >= threshold) return "covered";
  // Distance from the threshold, as a fraction of it: 1.0 at zero collateral,
  // 0 right at the line.
  const towardLine = (threshold - healthPct) / threshold;
  if (towardLine >= 0.5) return "danger";
  if (towardLine >= 0.2) return "warning";
  return "safe";
}
