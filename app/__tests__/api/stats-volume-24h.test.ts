/**
 * GH#2676: /api/stats' PRIMARY path (computeStatsFromMarketsApi) returned a
 * literal `totalVolume24h: 0` / `trades24h: 0` while the very rows it loaded
 * carried the indexer's 24h volume — shadowing the #2083 volume fix that lives
 * in the later fallback paths. The dashboard showed $0 beside a markets list
 * with ~$5K of volume.
 *
 * Also pins the unit the total and the rows share: volume_24h is engine Q
 * (scale 1e6, mint-decimals independent), so SOL (decimals 9) is ~$397, not
 * the $0.40 /api/markets used to serve by dividing by 10^9.
 *
 * Calls the REAL route handlers over the SAME mocked rows (the live devnet rows
 * at fix time, field for field), so the test exercises the code that runs.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

const LIVE_ROWS = [
  { slab_address: "3t67LQPdgiSqGvXsYff3Pzv2uHtM1zZ7f29HsnEzb6vJ", mint_address: "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC", symbol: "COLLECT", decimals: 6, last_price: 0.019281, volume_24h: 85420329419, trade_count_24h: 6, vault_balance: 2099892986, c_tot: 1388510895, total_open_interest: 55705224804, total_open_interest_usd: 1074.05, is_complete: true, oracle_mode: "admin" },
  { slab_address: "5bVTTMRceF9qEERjPWvqxtrDighE846QkVXSJm4uC8Tk", mint_address: "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC", symbol: "ANSEM", decimals: 6, last_price: 0.146944, volume_24h: 16511677058, trade_count_24h: 1, vault_balance: 4500000000, c_tot: 2934000524, total_open_interest: 33023354116, total_open_interest_usd: 4852.58, is_complete: true, oracle_mode: "admin" },
  { slab_address: "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr", mint_address: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9, last_price: 117.086498, volume_24h: 3396789, trade_count_24h: 3, vault_balance: 51529591886, c_tot: 51482375164, total_open_interest: 0, total_open_interest_usd: 0, is_complete: true, oracle_mode: "admin" },
  { slab_address: "BPLPf1XT7HE9qKwAbf4cSqcDrV6VHJDS3FPeQ3GL7JPY", mint_address: "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC", symbol: "PAID", decimals: 6, last_price: 0.014173, volume_24h: 22119000000, trade_count_24h: 1, vault_balance: 7475000000, c_tot: 6762213126, total_open_interest: 73270632562, total_open_interest_usd: 1038.46, is_complete: true, oracle_mode: "admin" },
  { slab_address: "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE", mint_address: "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC", symbol: "CATE", decimals: 6, last_price: 0.078315, volume_24h: 14032613818, trade_count_24h: 3, vault_balance: 2599913372, c_tot: 2304901289, total_open_interest: 12801547564, total_open_interest_usd: 1002.55, is_complete: true, oracle_mode: "admin" },
];

const mocks = vi.hoisted(() => ({ loadMergedMarketRows: vi.fn() }));

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/market-registry", () => ({ loadMergedMarketRows: mocks.loadMergedMarketRows, MARKET_SELECT_FIELDS: "" }));
vi.mock("@/lib/config", () => ({
  getConfig: vi.fn(() => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com", programId: "11111111111111111111111111111112" })),
}));
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: vi.fn() }));
vi.mock("@/lib/upstash-rate-limit", () => ({
  createUpstashRateLimiter: () => ({ check: async () => ({ allowed: true }) }),
}));

import { GET as statsGET } from "@/app/api/stats/route";
import { GET as marketsGET } from "@/app/api/markets/route";

async function callStats(): Promise<Record<string, unknown>> {
  mocks.loadMergedMarketRows.mockResolvedValue(LIVE_ROWS.map((r) => ({ ...r })));
  const res = await statsGET(new NextRequest("http://localhost/api/stats"));
  return (await res.json()) as Record<string, unknown>;
}

async function callMarkets(): Promise<Array<Record<string, unknown>>> {
  mocks.loadMergedMarketRows.mockResolvedValue(LIVE_ROWS.map((r) => ({ ...r })));
  const res = await marketsGET(new NextRequest("http://localhost/api/markets"));
  const body = (await res.json()) as { markets: Array<Record<string, unknown>> };
  return body.markets;
}

describe("GH#2676 /api/stats 24h volume on the primary (registry) path", () => {
  it("CONTROL: the primary path ran on these rows", async () => {
    const stats = await callStats();
    expect(mocks.loadMergedMarketRows).toHaveBeenCalled();
    expect(stats.totalMarkets).toBe(LIVE_ROWS.length);
    expect(stats.totalOpenInterest as number).toBeGreaterThan(0);
    expect(stats.live).toBe(true);
  });

  it("sums the rows' 24h volume instead of returning a literal 0", async () => {
    const stats = await callStats();
    // COLLECT 1646.99 + ANSEM 2426.28 + SOL 397.72 + PAID 313.49 + CATE 1098.96
    expect(stats.totalVolume24h as number).toBeCloseTo(5883.44, 1);
    expect(stats.trades24h).toBe(14);
  });

  it("reports unique traders as unknown (null), not a fabricated 0", async () => {
    const stats = await callStats();
    expect(stats.totalTraders).toBeNull();
  });
});

describe("GH#2676 /api/markets volume_24h_usd uses engine Q units (not mint decimals)", () => {
  it("SOL (decimals 9) reads ~$397, not $0.40", async () => {
    const rows = await callMarkets();
    const sol = rows.find((r) => r.symbol === "SOL");
    expect(sol?.volume_24h_usd).toBeCloseTo(397.72, 1);
  });

  it("the dashboard total equals the sum of the rows the list serves", async () => {
    const rows = await callMarkets();
    const sum = rows.reduce((s, r) => s + (Number(r.volume_24h_usd) || 0), 0);
    const stats = await callStats();
    expect(stats.totalVolume24h as number).toBeCloseTo(sum, 2);
  });
});
