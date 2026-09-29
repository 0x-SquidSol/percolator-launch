/**
 * GH#2676 — /api/stats reports the 24h volume it loaded, instead of a literal 0.
 *
 * The primary path (`computeStatsFromMarketsApi`) returned a hard-coded
 * `totalVolume24h: 0` under a comment about there being "no on-chain source for
 * trade history". True of the discovery path below it; not true there. Those
 * rows come from `loadMergedMarketRows`, which selects `volume_24h` and
 * `trade_count_24h`, and the zombie filter reads `row.volume_24h` twelve lines
 * earlier to decide visibility. The number was in hand and discarded.
 *
 * Because that path returns non-null, the handler never fell through to the
 * Supabase aggregation that still carries the `GH#2083:` fix for this exact
 * symptom. The fix was not reverted; a new path was added in front of it.
 *
 * WHY THIS CALLS THE REAL HANDLER. The sibling tests in this directory
 * re-derive the aggregation and assert on the copy. That cannot work here: the
 * defect was a literal short-circuiting the function that computes the value,
 * so a reproduction would be exercising code that never runs and would pass on
 * a broken route.
 *
 * WHY THE FIXTURE IS LIVE DATA. Two earlier versions of it were wrong in ways
 * the controls caught — a `vault_balance: 500` below MIN_VAULT_FOR_OI (which
 * made the phantom-OI guard zero the OI), and a `volume_24h_usd` field that
 * `MARKET_SELECT_FIELDS` does not select, so the route never receives it. The
 * rows below are transcribed from
 * https://percolator-playground.vercel.app/api/markets on 2026-09-28, carrying
 * only fields the merged registry really supplies.
 *
 * They total $5,034.61. An earlier read of the SAME five markets totalled
 * $5,081.74 with identical raw volumes -- only `last_price` had moved. Worth
 * knowing: this figure drifts with the mark even when no new trade occurs,
 * which is why the expected total below is DERIVED from the fixture rather
 * than pinned to a number observed at some other moment.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ loadMergedMarketRows: vi.fn() }));

vi.mock("@/lib/market-registry", () => ({ loadMergedMarketRows: mocks.loadMergedMarketRows }));
vi.mock("@/lib/upstash-rate-limit", () => ({
  createUpstashRateLimiter: () => ({ check: async () => ({ allowed: true }) }),
}));
vi.mock("@/lib/get-client-ip", () => ({ getClientIp: () => "127.0.0.1" }));

import { GET } from "@/app/api/stats/route";
import { rawToUsd, sanitizePriceUsd } from "@/lib/market-usd";
import { NextRequest } from "next/server";

/**
 * The five markets with live 24h volume. `volume_24h` is RAW base units and
 * `decimals` differs per market — SOL is 9, the rest 6 — which is exactly the
 * conversion a hard-coded zero skipped. `total_accounts` is null, the real
 * value under the reduced 2026-07 schema (phantom-oi.ts: "unknown is not zero").
 */
const LIVE_ROWS = [
  { symbol: "PAID",    volume_24h: 14_516_316_281, decimals: 6, last_price: 0.014077,   trade_count_24h: 1, vault_balance: 6_975_000_000,  total_open_interest_usd: 366.89 },
  { symbol: "COLLECT", volume_24h: 69_707_764_605, decimals: 6, last_price: 0.01787,    trade_count_24h: 5, vault_balance: 1_599_892_986,  total_open_interest_usd: 430.97 },
  { symbol: "ANSEM",   volume_24h: 16_511_677_058, decimals: 6, last_price: 0.150484,   trade_count_24h: 1, vault_balance: 4_500_000_000,  total_open_interest_usd: 5108.42 },
  { symbol: "SOL",     volume_24h: 3_396_789,      decimals: 9, last_price: 118.162696, trade_count_24h: 3, vault_balance: 51_529_591_886, total_open_interest_usd: 0 },
  { symbol: "CATE",    volume_24h: 14_032_613_818, decimals: 6, last_price: 0.078349,   trade_count_24h: 3, vault_balance: 2_599_913_372,  total_open_interest_usd: 1005.92 },
].map((m, i) => ({
  slab_address: `Slab${i}111111111111111111111111111111111111`,
  total_open_interest: 5_000_000,
  c_tot: 500,
  ...m,
}));

/** What /api/markets publishes per row, so the total is the sum of what a user can read. */
const PER_MARKET_USD = LIVE_ROWS.map((r) =>
  rawToUsd(r.volume_24h, r.decimals, sanitizePriceUsd(r.last_price)),
);
const EXPECTED_VOLUME = Math.round(PER_MARKET_USD.reduce((s, v) => s + (v ?? 0), 0) * 100) / 100;
const EXPECTED_TRADES = LIVE_ROWS.reduce((s, r) => s + r.trade_count_24h, 0);

async function callStats(rows: unknown[] = LIVE_ROWS) {
  mocks.loadMergedMarketRows.mockResolvedValue(rows);
  const res = await GET(new NextRequest("http://localhost/api/stats"));
  return (await res.json()) as Record<string, number>;
}

beforeEach(() => vi.clearAllMocks());

describe("CONTROLS — the harness reaches the path under test", () => {
  it("the primary path ran and produced its other real numbers", async () => {
    // Without this, a correct volume could coexist with the handler having
    // fallen through to an entirely different source.
    const stats = await callStats();
    expect(mocks.loadMergedMarketRows).toHaveBeenCalled();
    expect(stats.totalMarkets).toBe(LIVE_ROWS.length);
    expect(stats.totalOpenInterest).toBeGreaterThan(0);
    expect(stats.live).toBe(true);
  });

  it("the fixture carries volume the route has to convert, not a pre-computed total", () => {
    // MARKET_SELECT_FIELDS selects volume_24h (raw) and NOT volume_24h_usd, so
    // a fixture supplying the USD field would test a route that cannot exist.
    for (const r of LIVE_ROWS) {
      expect(r).not.toHaveProperty("volume_24h_usd");
      expect(r.volume_24h).toBeGreaterThan(0);
    }
    expect(EXPECTED_VOLUME).toBeGreaterThan(5000);
    expect(EXPECTED_TRADES).toBe(13);
  });
});

describe("GH#2676 — the 24h volume is reported", () => {
  it("sums the volume across the visible markets", async () => {
    const stats = await callStats();
    expect(stats.totalVolume24h).toBeCloseTo(EXPECTED_VOLUME, 2);
    // THE REGRESSION, stated separately so the failure message is unambiguous.
    expect(stats.totalVolume24h).not.toBe(0);
  });

  it("sums the trade count too", async () => {
    const stats = await callStats();
    expect(stats.trades24h).toBe(EXPECTED_TRADES);
  });

  it("agrees EXACTLY with the sum of the per-market figures", async () => {
    // The contract: the protocol total is the sum of the numbers a user can
    // read in the list. Asserted with toBe, not toBeCloseTo -- a 2dp tolerance
    // would hide exactly the float artifact the re-round exists to remove.
    //
    // This does NOT cover rawToUsd itself: EXPECTED_VOLUME is derived with the
    // same helper the route uses, so a conversion regression cancels out. The
    // hard constants in __tests__/lib/market-usd.test.ts do that job; this file
    // pins summation over the right ROWS.
    const stats = await callStats();
    expect(stats.totalVolume24h).toBe(EXPECTED_VOLUME);
  });

  it("converts per-market decimals rather than assuming 6", async () => {
    // SOL is 9 decimals and 3_396_789 raw. Read as 6 it would contribute ~$401
    // instead of $0.40 — a 1000x error that a fixture of uniform-decimals rows
    // could never catch. (I made exactly that mistake computing this by hand.)
    const solOnly = await callStats([LIVE_ROWS.find((r) => r.symbol === "SOL")!]);
    expect(solOnly.totalVolume24h).toBeLessThan(1);
    expect(solOnly.totalVolume24h).toBeGreaterThan(0);
  });
});

describe("GH#2676 — the total is free of float artifacts", () => {
  it("re-rounds the sum, not just the parts", async () => {
    // Summing 2dp values reintroduces the artifact each was rounded to remove:
    // 10.1 + 20.2 + 30.3 is 60.599999999999994 in IEEE-754.
    //
    // The five live rows happen to sum EXACTLY, so every other test in this
    // file passes with the re-round deleted -- it was dead weight until this
    // case existed. Chosen so each row converts to one of those three values.
    const rows = [10.1, 20.2, 30.3].map((usd, i) => ({
      ...LIVE_ROWS[0],
      slab_address: `Round${i}11111111111111111111111111111111111`,
      volume_24h: Math.round(usd * 1_000_000),
      decimals: 6,
      last_price: 1,
      trade_count_24h: 1,
    }));
    const naive = [10.1, 20.2, 30.3].reduce((a, b) => a + b, 0);
    // CONTROL: this input really does produce an artifact, so the assertion
    // below is about the re-round and not a sum that was already clean.
    expect(naive).not.toBe(60.6);

    const stats = await callStats(rows);
    expect(stats.totalVolume24h).toBe(60.6);
  });
});

describe("GH#2676 — unknown is not zero", () => {
  it("skips a market whose volume cannot be priced, and still reports the rest", async () => {
    // A null conversion means "cannot be known", which must not be summed as 0
    // and must not poison the total either.
    const rows = [
      { ...LIVE_ROWS[0] },
      { ...LIVE_ROWS[1], last_price: 0 }, // unusable price -> rawToUsd returns null
    ];
    const stats = await callStats(rows);
    const only = rawToUsd(LIVE_ROWS[0].volume_24h, LIVE_ROWS[0].decimals, sanitizePriceUsd(LIVE_ROWS[0].last_price))!;
    expect(stats.totalVolume24h).toBeCloseTo(only, 2);
  });

  it("excludes a market whose last_price is corrupt", async () => {
    // GH#1191: a $7.9T/token price turns a legitimate amount into billions, and
    // the protocol total is exactly where that lands. The route must sanitize
    // the price before converting, not just trust the column.
    //
    // The price is chosen so the PRICE guard is what excludes it. At $7.9T the
    // resulting USD blows past the $10B per-market cap and rawToUsd rejects it
    // for that reason instead, which let a mutant dropping sanitizePriceUsd
    // survive. $2M/token over 1,000 tokens is $2B: above the $1M price cap,
    // comfortably under the value cap.
    const rows = [
      { ...LIVE_ROWS[0] },
      { ...LIVE_ROWS[1], volume_24h: 1_000_000_000, decimals: 6, last_price: 2_000_000 },
    ];
    const stats = await callStats(rows);
    const onlyGood = rawToUsd(LIVE_ROWS[0].volume_24h, LIVE_ROWS[0].decimals, sanitizePriceUsd(LIVE_ROWS[0].last_price))!;
    expect(stats.totalVolume24h).toBeCloseTo(onlyGood, 2);
    // CONTROL: the corrupt row was still visible, so it was excluded by the
    // price guard rather than filtered out before the sum ever saw it.
    expect(stats.totalMarkets).toBe(2);
  });

  it("excludes a filtered-out market's TRADE COUNT, not just its volume", async () => {
    // A market with volume can never be a zombie -- isZombieMarket counts
    // volume as activity -- so looping over `rows` instead of `visible` is
    // invisible on the volume axis. `trade_count_24h` is NOT consulted by that
    // filter, so the trades axis is where the distinction is observable.
    const zombie = {
      slab_address: "Zombie111111111111111111111111111111111111",
      symbol: "DEAD", decimals: 6,
      last_price: null, volume_24h: 0, trade_count_24h: 99,
      total_open_interest: 0, total_open_interest_usd: 0,
      vault_balance: 0, c_tot: 0,
    };
    const stats = await callStats([...LIVE_ROWS, zombie]);
    // CONTROL: the row really was filtered, otherwise this proves nothing.
    expect(stats.totalMarkets).toBe(LIVE_ROWS.length);
    expect(stats.trades24h).toBe(EXPECTED_TRADES);
    expect(stats.trades24h).not.toBe(EXPECTED_TRADES + 99);
  });

  it("reports a genuine zero as zero", async () => {
    // The other half of GH#1578: a market that really traded nothing.
    const stats = await callStats([{ ...LIVE_ROWS[0], volume_24h: 0, trade_count_24h: 0 }]);
    expect(stats.totalVolume24h).toBe(0);
    expect(stats.trades24h).toBe(0);
    // CONTROL: the row was still counted, so this is a real zero and not a
    // market that got filtered out before the sum.
    expect(stats.totalMarkets).toBe(1);
  });
});
