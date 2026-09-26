/**
 * Which of the chart's candle sources should back the visible series.
 *
 * WHY THIS IS A MODULE AND NOT FOUR BOOLEANS IN THE COMPONENT
 *
 * The rule below used to be computed inline in TradingChart.tsx as a chain of
 * interdependent booleans, and it shipped a defect that no test could see: a
 * Percolator series of ONE bar outranked a DEX series of a THOUSAND.
 *
 * Measured on SOL/USD, 5m: the chart drew a flat line at 114.629292 with the
 * price axis pinned to 114.58-114.68, while the header read $121.253 and the
 * DEX source held 1000 bars ending at 121.51. One stale internal trade beat
 * three and a half days of correct data.
 *
 * The mechanism was an escape hatch that quietly changed meaning. It read:
 *
 *     hasPercolatorData = perc.success && priced > 0 && (priced >= 10 || pythHasNothing)
 *
 * and its own comment explained `pythHasNothing` as a PER-TOKEN condition —
 * "Pyth has no feed for this long-tail asset". Then Pyth removed its
 * TradingView shim upstream (`/v1/shims/tradingview/*` now 404s, while
 * `/v1/price_feeds` still returns 200), so `pythStatus === "error"` became
 * permanent for every Pyth-mapped market. A per-token exception became a
 * global one, the >= 10 threshold was bypassed everywhere, and because the DEX
 * source is only consulted AFTER Percolator loses, it was never reached.
 *
 * The fix is one clause: a sub-threshold Percolator series may only win when
 * BOTH other sources have actually settled with nothing. It keeps the hatch's
 * real intent — "any internal data beats a blank chart" — and denies it the
 * power to outrank a healthy source.
 *
 * A source that is still LOADING is deliberately not "nothing". That is what
 * stops the stub flashing in during the DEX round trip, which is the flicker
 * users see as "good chart for a second, then one line".
 */

import type { ChartDataSource } from "@/lib/chart-live-tick";

export type ChartFetchStatus = "idle" | "loading" | "success" | "error";

export interface ChartSourceState {
  status: ChartFetchStatus;
  /**
   * Bars with a REAL price — not merely finite.
   *
   * 0 is finite, and the indexer buckets a NULL-price liquidation marker into
   * an o=h=l=c=0 candle, so counting finite bars promotes markets into a
   * source whose bars are all zeros: a flat line at 0.00 instead of a chart.
   * Callers must filter on `> 0`, not on `Number.isFinite`.
   */
  pricedBars: number;
}

/**
 * Bars a Percolator series needs before it can stand on its own.
 *
 * Below this, one or two candles against a multi-day window render as a
 * mostly-empty chart that looks broken, so a deep external source is the
 * better background until real internal volume arrives. The user's own fill
 * still shows: the entry line draws over whichever source is displayed.
 */
export const MIN_PERC_BARS = 10;

/** Settled with no usable data — as opposed to still in flight. */
function settledEmpty(s: ChartSourceState): boolean {
  if (s.status === "error") return true;
  return s.status === "success" && s.pricedBars === 0;
}

function hasData(s: ChartSourceState): boolean {
  return s.status === "success" && s.pricedBars > 0;
}

export interface ChartSourceInputs {
  percolator: ChartSourceState;
  pyth: ChartSourceState;
  dex: ChartSourceState;
}

/**
 * Pick the backing source.
 *
 * Order of preference, and the reason for each:
 *
 *   1. Percolator WITH enough bars — the market's own trades are the truest
 *      series when there are enough of them to read.
 *   2. Pyth — deep spot history for a mapped asset.
 *   3. DEX — the mint's pool history; deep, but a different venue.
 *   4. Percolator with ANY bars, but ONLY once Pyth and DEX have both settled
 *      empty. Something beats nothing; it must not beat something.
 *   5. Oracle — the market's own mark history, the last resort.
 */
export function selectChartSource(
  { percolator, pyth, dex }: ChartSourceInputs,
  minPercBars: number = MIN_PERC_BARS,
): ChartDataSource {
  if (percolator.status === "success" && percolator.pricedBars >= minPercBars) {
    return "percolator";
  }
  if (hasData(pyth)) return "pyth";
  if (hasData(dex)) return "dex";
  if (
    percolator.status === "success" &&
    percolator.pricedBars > 0 &&
    settledEmpty(pyth) &&
    settledEmpty(dex)
  ) {
    return "percolator";
  }
  return "oracle";
}
