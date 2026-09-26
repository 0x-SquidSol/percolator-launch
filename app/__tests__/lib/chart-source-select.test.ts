/**
 * The chart drew a flat line at 114.629292 — ONE stale internal trade — with
 * the price axis pinned to 114.58-114.68, while the header read $121.253 and
 * the DEX source held 1000 bars ending at 121.51.
 *
 * Cause: Pyth removed its TradingView shim upstream, so `pythStatus` became
 * permanently "error". That tripped an escape hatch written for a PER-TOKEN
 * condition ("this long-tail asset has no Pyth feed"), which bypassed the
 * >= 10 bar threshold for every mapped market — and because the DEX source was
 * only consulted after Percolator lost, it was never reached.
 *
 * See lib/chart-source-select.ts.
 */

import { describe, expect, it } from "vitest";
import {
  selectChartSource,
  MIN_PERC_BARS,
  type ChartSourceState,
} from "@/lib/chart-source-select";

const none: ChartSourceState = { status: "success", pricedBars: 0 };
const loading: ChartSourceState = { status: "loading", pricedBars: 0 };
const idle: ChartSourceState = { status: "idle", pricedBars: 0 };
const errored: ChartSourceState = { status: "error", pricedBars: 0 };
const bars = (n: number): ChartSourceState => ({ status: "success", pricedBars: n });

describe("a thin internal series must not outrank a healthy one", () => {
  it("THE BUG: 1 Percolator bar loses to 1000 DEX bars when Pyth is dead", () => {
    // Exactly the shipped defect, in the numbers measured on SOL/USD 5m.
    expect(
      selectChartSource({ percolator: bars(1), pyth: errored, dex: bars(1000) }),
    ).toBe("dex");
  });

  it("loses to Pyth too, when Pyth is the one with data", () => {
    expect(
      selectChartSource({ percolator: bars(1), pyth: bars(500), dex: none }),
    ).toBe("pyth");
  });

  it("holds at every count below the threshold", () => {
    for (let n = 1; n < MIN_PERC_BARS; n++) {
      expect(
        selectChartSource({ percolator: bars(n), pyth: errored, dex: bars(1000) }),
      ).toBe("dex");
    }
  });

  it("CONTROL: at the threshold Percolator wins, as it always should have", () => {
    // Guards against fixing the override by disabling the internal source —
    // the market's own trades ARE the truest series once there are enough.
    expect(
      selectChartSource({ percolator: bars(MIN_PERC_BARS), pyth: bars(500), dex: bars(1000) }),
    ).toBe("percolator");
  });

  it("CONTROL: one bar below the threshold does not win", () => {
    // The classic off-by-one on a `>=` boundary.
    expect(
      selectChartSource({ percolator: bars(MIN_PERC_BARS - 1), pyth: bars(500), dex: none }),
    ).toBe("pyth");
  });
});

describe("something still beats nothing", () => {
  it("a lone Percolator bar wins once BOTH other sources settle empty", () => {
    // The escape hatch's real intent, preserved: a long-tail token with no
    // Pyth feed and no DEX pool should show its own trades rather than a
    // blank chart.
    expect(
      selectChartSource({ percolator: bars(1), pyth: errored, dex: none }),
    ).toBe("percolator");
    expect(
      selectChartSource({ percolator: bars(3), pyth: none, dex: errored }),
    ).toBe("percolator");
  });

  it("falls to the oracle when nothing has any bars", () => {
    expect(selectChartSource({ percolator: none, pyth: errored, dex: errored })).toBe("oracle");
  });
});

describe("a source still loading is not a source with nothing", () => {
  it("does not promote a thin series while the DEX request is in flight", () => {
    // THE FLICKER: the stub used to flash in during the DEX round trip and
    // then be replaced, which read as "good chart for a second, then one line".
    expect(
      selectChartSource({ percolator: bars(1), pyth: errored, dex: loading }),
    ).toBe("oracle");
  });

  it("promotes it once that request settles with nothing", () => {
    // CONTROL for the above: "wait for loading" must not become "wait forever".
    expect(
      selectChartSource({ percolator: bars(1), pyth: errored, dex: none }),
    ).toBe("percolator");
  });

  it("treats an idle source as not-yet-settled too", () => {
    // `idle` is what usePythChart reports for an asset with no Pyth mapping —
    // distinct from `error`, and it must not count as "settled empty" either.
    expect(
      selectChartSource({ percolator: bars(1), pyth: idle, dex: loading }),
    ).toBe("oracle");
  });
});

describe("precedence between the two external sources", () => {
  it("prefers Pyth over DEX when both have data", () => {
    expect(
      selectChartSource({ percolator: none, pyth: bars(200), dex: bars(1000) }),
    ).toBe("pyth");
  });

  it("uses DEX when Pyth has errored", () => {
    // The state every Pyth-mapped market is in today.
    expect(
      selectChartSource({ percolator: none, pyth: errored, dex: bars(184) }),
    ).toBe("dex");
  });
});

describe("zero-priced bars never count", () => {
  it("ignores a Percolator series whose bars are all unpriced", () => {
    // The indexer buckets a NULL-price liquidation marker into o=h=l=c=0.
    // Those are finite, so a finiteness check alone would promote a flat line
    // at 0.00 over a real chart. Callers pass the PRICED count for this reason.
    expect(
      selectChartSource({ percolator: bars(0), pyth: errored, dex: bars(184) }),
    ).toBe("dex");
  });
});
