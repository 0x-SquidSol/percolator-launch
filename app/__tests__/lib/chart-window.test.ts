/**
 * The chart showed "one line", too few bars, or nothing at all, depending on
 * the timeframe and the market.
 *
 * Measured against the live playground while diagnosing it — SOL-PERP, the
 * only devnet market carrying real trades:
 *
 *   timeframe   shipped window   bars returned   all-time bars
 *   1m          2h               none            6
 *   5m          8h               1               5
 *   15m         24h              1               5
 *
 * Its newest 1-minute bar was 2.6h old against a 2.0h window. The trades
 * existed; the request excluded them. See lib/chart-window.ts.
 */

import { describe, expect, it } from "vitest";
import {
  CHART_WINDOWS,
  MAX_BARS_PER_REQUEST,
  MIN_WINDOW_SEC,
  maxBarsFor,
  windowCovers,
  type ChartTimeframe,
} from "@/lib/chart-window";

const ALL = Object.keys(CHART_WINDOWS) as ChartTimeframe[];
const HOUR = 3600;

describe("chart windows must catch a sparse market's trades", () => {
  it("covers the market that was reported broken", () => {
    // The exact measurement: SOL-PERP's most recent trade was 2.6h old and the
    // 1m chart rendered nothing. Every intraday timeframe must include it.
    const ageSec = 2.6 * HOUR;
    for (const tf of ["1m", "5m", "15m", "1h", "4h", "1d"] as ChartTimeframe[]) {
      expect(windowCovers(tf, ageSec), `${tf} must cover a 2.6h-old trade`).toBe(true);
    }
  });

  it("the shipped 2h window did NOT cover it — this is the regression guard", () => {
    // Pinning the old value so the fix cannot be silently reverted to it.
    const SHIPPED_1M_WINDOW = 2 * HOUR;
    expect(2.6 * HOUR).toBeGreaterThan(SHIPPED_1M_WINDOW);
    expect(CHART_WINDOWS["1m"].lookbackSec).toBeGreaterThan(SHIPPED_1M_WINDOW);
  });

  it("every timeframe reaches back at least a day", () => {
    // A market trading a few times a day has something on every timeframe,
    // rather than only on the long ones.
    for (const tf of ALL) {
      expect(CHART_WINDOWS[tf].lookbackSec, tf).toBeGreaterThanOrEqual(MIN_WINDOW_SEC);
    }
  });

  it("a market trading once a day charts on every timeframe", () => {
    const ageSec = 24 * HOUR;
    for (const tf of ALL) {
      expect(windowCovers(tf, ageSec), tf).toBe(true);
    }
  });
});

describe("widening must not produce a payload the chart cannot draw", () => {
  it("CONTROL: every timeframe stays under the bar ceiling", () => {
    // Load-bearing. Without it, "cover sparse markets" could be satisfied by
    // requesting all of history on every timeframe — which fixes the empty
    // chart by replacing it with an unrenderable one, and by hammering the
    // 50k-row query cap in queryTradesForCandles.
    for (const tf of ALL) {
      expect(maxBarsFor(tf), `${tf} bar ceiling`).toBeLessThanOrEqual(MAX_BARS_PER_REQUEST);
    }
  });

  it("CONTROL: longer timeframes still reach further back", () => {
    // Without this, the table could be "everything gets the same huge window",
    // which would make the timeframe selector meaningless.
    const ordered: ChartTimeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
    for (let i = 1; i < ordered.length; i++) {
      expect(
        CHART_WINDOWS[ordered[i]].lookbackSec,
        `${ordered[i]} must reach further than ${ordered[i - 1]}`,
      ).toBeGreaterThan(CHART_WINDOWS[ordered[i - 1]].lookbackSec);
    }
  });

  it("CONTROL: a trade older than the window is still excluded", () => {
    // "Cover sparse markets" must not become "never filter anything" — the
    // window still has to bound the query.
    expect(windowCovers("1m", 40 * HOUR)).toBe(false);
    expect(windowCovers("1d", 4000 * 24 * HOUR)).toBe(false);
  });

  it("bucket sizes are the real bar lengths", () => {
    expect(CHART_WINDOWS["1m"].bucketSec).toBe(60);
    expect(CHART_WINDOWS["5m"].bucketSec).toBe(300);
    expect(CHART_WINDOWS["1h"].bucketSec).toBe(3600);
    expect(CHART_WINDOWS["1d"].bucketSec).toBe(86_400);
  });

  it("CONTROL: the shared table carries NO resolution string", () => {
    // Load-bearing, and it caught a regression while this was being written.
    // The two hooks had identical windows but different resolutions — our UDF
    // route wants "1D", Pyth Benchmarks wants "D". Folding both tables into
    // one here sends "1D" to Pyth and silently breaks every daily chart on
    // that source. Only the WINDOW is shared, because only the window was the
    // bug; each hook keeps its own resolution.
    for (const tf of ALL) {
      expect(CHART_WINDOWS[tf]).not.toHaveProperty("resolution");
    }
  });
});
