/**
 * Binds the chart-window fix to the source.
 *
 * `__tests__/lib/chart-window.test.ts` covers the window table. It cannot see
 * whether the hooks actually USE it, or whether they still send the right
 * resolution string to two different APIs — and both of those are where the
 * risk is. Same technique, and the same reason, as
 * create-market-launch-gate.test.ts.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const PERC = fs.readFileSync(
  path.resolve(__dirname, "../../hooks/usePercolatorCandles.ts"),
  "utf8",
);
const PYTH = fs.readFileSync(
  path.resolve(__dirname, "../../hooks/usePythChart.ts"),
  "utf8",
);

describe("both candle sources share one window table", () => {
  it("neither hook hard-codes its own lookback numbers any more", () => {
    // The windows were duplicated across these two files. Widening one and
    // leaving the other would have the two sources disagreeing about how far
    // back "1m" means, which is worse than both being wrong the same way.
    for (const [name, src] of [["usePercolatorCandles", PERC], ["usePythChart", PYTH]] as const) {
      expect(src, name).toContain("CHART_WINDOWS");
      // the old shape: `lookbackSec: 2 * 3600` / `lookbackSecs: 8 * 3600`
      expect(src, name).not.toMatch(/lookbackSecs?:\s*\d+\s*\*\s*3600/);
      expect(src, name).not.toMatch(/lookbackSecs?:\s*\d+\s*\*\s*86400/);
    }
  });
});

describe("each source keeps the resolution string its own API expects", () => {
  it("Pyth Benchmarks gets D for daily, never 1D", () => {
    // Pyth wants "D"; our UDF route wants "1D". The two tables agreed on every
    // window and differed on exactly this, so merging them wholesale sends
    // "1D" to Pyth and silently breaks every daily chart on that source.
    expect(PYTH).toMatch(/"1d":\s*"D"/);
    expect(PYTH).not.toMatch(/"1d":\s*"1D"/);
  });

  it("the UDF candles route gets 1D for daily, never bare D", () => {
    expect(PERC).toMatch(/"1d":\s*"1D"/);
  });
});

describe("the window actually reaches the request", () => {
  it("both hooks derive `from` from the shared lookback, not a literal", () => {
    // The regexes above only prove CHART_WINDOWS is imported. A mutant that
    // imports it and then writes `const from = to - 7200` reintroduces the
    // original bug and passes every one of them. Pin the derivation itself.
    expect(PERC).toMatch(/const\s+from\s*=\s*to\s*-\s*lookbackSec\s*;/);
    expect(PYTH).toMatch(/const\s+from\s*=\s*to\s*-\s*lookbackSecs\s*;/);
  });

  it("the empty short-circuit actually returns before fetching", () => {
    // Asserting that `emptyCache.get` appears somewhere does not prove the
    // fetch is skipped: deleting the `return`, inverting the comparison, or
    // moving the block below the fetch all leave the call in place.
    const block = PERC.slice(
      PERC.indexOf("const emptyAt = emptyCache.get("),
      PERC.indexOf("if (endpointUnavailable)"),
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).toMatch(/Date\.now\(\)\s*-\s*emptyAt\s*<\s*EMPTY_CACHE_TTL_MS/);
    expect(block).toMatch(/return\s*;/);
    // ...and it must sit ahead of the network call, not after it.
    expect(PERC.indexOf("const emptyAt = emptyCache.get(")).toBeLessThan(
      PERC.indexOf("await fetch(`/api/candles/"),
    );
  });

  it("a live trade drops the remembered emptiness", () => {
    // Otherwise the user's own first fill is hidden behind the TTL.
    expect(PERC).toMatch(/emptyCache\.delete\(`\$\{slabAddress\}:\$\{timeframe\}`\)/);
  });

  it("a fresh Pyth batch short-circuits the refetch", () => {
    // usePythChart painted from cache and then fetched anyway, so every
    // timeframe click cost a round trip on any Pyth-backed market — the
    // reported "takes forever when switching timeframe".
    expect(PYTH).toContain("REFETCH_SKIP_MS");
    expect(PYTH).toMatch(/if\s*\(Date\.now\(\)\s*-\s*cached\.at\s*<\s*REFETCH_SKIP_MS\)\s*return\s*;/);
  });
});

describe("an empty answer is remembered briefly, not re-fetched every click", () => {
  it("no_data is cached with a TTL rather than discarded", () => {
    // /api/candles costs 600-1400ms. Previously `no_data` was never cached, so
    // on an unindexed market — most of them — every timeframe click re-paid
    // that round trip for an answer that had not changed.
    expect(PERC).toContain("EMPTY_CACHE_TTL_MS");
    expect(PERC).toMatch(/emptyCache\.get\(/);
    expect(PERC).toMatch(/boundedSet\(\s*emptyCache/);
  });

  it("CONTROL: the TTL is short, so a newly indexed market still appears", () => {
    // Without a bound this becomes the bug the original comment warned about:
    // "a market whose candles simply haven't been indexed yet would then paint
    // blank from cache forever". Must stay well under the 10-minute success
    // cache.
    const m = PERC.match(/EMPTY_CACHE_TTL_MS\s*=\s*([0-9_]+)/);
    expect(m, "EMPTY_CACHE_TTL_MS must be a literal").not.toBeNull();
    const ttl = Number(m![1].replace(/_/g, ""));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120_000);
  });
});
