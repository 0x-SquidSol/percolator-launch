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

  it("treats an APPLICABLE idle source as not-yet-settled", () => {
    // A source that has simply not started yet must not count as "nothing".
    // An INAPPLICABLE idle source is different and is covered below.
    //
    // `dex` is SETTLED here on purpose. With dex loading, the outcome was
    // decided by dex alone and the `idle` value was inert — an
    // idle-as-settled mutant survived this test unharmed.
    expect(
      selectChartSource({ percolator: bars(1), pyth: idle, dex: none }),
    ).toBe("oracle");
  });

  it("waits on a loading PYTH too, not just a loading DEX", () => {
    // Every other case pairs a settled dex with a settled pyth, so a version
    // that checked only `settledEmpty(dex)` and dropped pyth passed the whole
    // suite. The flicker is symmetric; the test has to be too.
    expect(
      selectChartSource({ percolator: bars(1), pyth: loading, dex: none }),
    ).toBe("oracle");
  });
});

describe("bars without a settled status do not count", () => {
  // Every fixture pairs `success` with a bar count, so the status guards were
  // never actually exercised: a version that dropped `status === "success"`
  // and looked only at `pricedBars` passed everything.
  it("ignores an in-flight Percolator batch that already carries bars", () => {
    expect(
      selectChartSource({
        percolator: { status: "loading", pricedBars: 50 },
        pyth: errored,
        dex: bars(184),
      }),
    ).toBe("dex");
  });

  it("does not let an in-flight Percolator batch take the last-resort slot", () => {
    expect(
      selectChartSource({
        percolator: { status: "loading", pricedBars: 5 },
        pyth: errored,
        dex: errored,
      }),
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

describe("the empty status", () => {
  // All three hooks report "empty" — not "success" with zero rows — for a
  // batch that came back with nothing. Checking only "success" made the
  // fallback unreachable for the commonest real case: a mint with no
  // GeckoTerminal pool, or an upstream 429 the route maps to an empty 200.
  const empty: ChartSourceState = { status: "empty", pricedBars: 0 };

  it("counts as settled, so a market still shows its own trades", () => {
    expect(
      selectChartSource({ percolator: bars(2), pyth: empty, dex: empty }),
    ).toBe("percolator");
  });

  it("mixes with error and inapplicable", () => {
    expect(
      selectChartSource({ percolator: bars(2), pyth: errored, dex: empty }),
    ).toBe("percolator");
  });

  it("CONTROL: an empty source still cannot WIN", () => {
    expect(
      selectChartSource({ percolator: none, pyth: empty, dex: bars(184) }),
    ).toBe("dex");
  });

  it("CONTROL: loading alongside empty still waits", () => {
    // Only `loading` blocks the fallback now; if "empty" had been folded in as
    // "pending", this would wrongly return percolator.
    expect(
      selectChartSource({ percolator: bars(2), pyth: empty, dex: loading }),
    ).toBe("oracle");
  });
});

describe("a source that can never answer is settled, not pending", () => {
  // useTokenChart sets `idle` and returns without fetching when its mint is
  // null; usePythChart does the same with no symbol mapping. Both stay there
  // for the life of the page.
  const inapplicable: ChartSourceState = { status: "idle", pricedBars: 0, applicable: false };

  it("shows a market its OWN trades when neither external source applies", () => {
    // THE REGRESSION THIS PREVENTS: a market with no mainnet_ca and no Pyth
    // mapping would otherwise sit on `idle` forever, never satisfy
    // "settled empty", and render the oracle series permanently instead of the
    // trades it actually has.
    expect(
      selectChartSource({
        percolator: bars(3),
        pyth: inapplicable,
        dex: inapplicable,
      }),
    ).toBe("percolator");
  });

  it("still waits on an applicable source that is merely loading", () => {
    // CONTROL: "inapplicable is settled" must not collapse into "idle is
    // settled", which would let the thin series flash in mid-round-trip again.
    expect(
      selectChartSource({
        percolator: bars(3),
        pyth: inapplicable,
        dex: { status: "loading", pricedBars: 0 },
      }),
    ).toBe("oracle");
  });

  it("an inapplicable source never wins even if it somehow reports bars", () => {
    expect(
      selectChartSource({
        percolator: none,
        pyth: { status: "success", pricedBars: 500, applicable: false },
        dex: bars(184),
      }),
    ).toBe("dex");
  });

  it("CONTROL: applicable defaults to true when omitted", () => {
    // Every other test in this file omits the flag; if the default flipped,
    // they would all silently change meaning.
    expect(
      selectChartSource({ percolator: bars(1), pyth: errored, dex: { status: "loading", pricedBars: 0 } }),
    ).toBe("oracle");
  });
});
