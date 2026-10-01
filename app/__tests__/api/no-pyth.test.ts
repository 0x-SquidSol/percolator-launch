/**
 * No Pyth in the playground (2026-10-01). The DEX (DexScreener pool -> keeper) and Jupiter paths
 * carry everything Pyth used to:
 *   - /api/oracle/resolve: no Pyth step, never `source: "pyth"` / `oracleMode: "pyth"`, even for
 *     SOL (which had a pinned Pyth feed); DexScreener first, Jupiter (Price API v3) as the price
 *     fallback; the old Jupiter v2 URL answered 404, so that fallback was silently dead;
 *   - price-ws: SOL/USD from Jupiter while fresh, else a DEX read of the SOL/USDC pool;
 *   - no code path calls Hermes / pyth.network for these.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const cache = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/bounded-ttl-cache", () => ({
  BoundedTtlCache: class {
    get(k: string) { return cache.get(k); }
    set(k: string, v: unknown) { cache.set(k, v); }
  },
}));
const owner = vi.hoisted(() => ({ classify: vi.fn() }));
vi.mock("@/lib/dex-pool-owner", async (orig) => ({ ...(await orig<typeof import("@/lib/dex-pool-owner")>()), classifyPoolsByOwner: owner.classify }));

import { GET } from "@/app/api/oracle/resolve/[ca]/route";
import { fetchJupiterSolUsdE6, fetchJupiterUsdPrice, parseJupiterUsdPrice, JUPITER_PRICE_URL } from "@/lib/jupiter-price";
import { pickSolUsdE6 } from "@/lib/priceStore/solUsd";

const SOL = "So11111111111111111111111111111111111111112";
const SOL_POOL = "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y"; // a SOL/USDC Meteora DLMM pool (raydium is withheld for new markets)
const resolve = (ca: string) => GET(new NextRequest(`http://localhost/api/oracle/resolve/${ca}`), { params: Promise.resolve({ ca }) });
const calls: string[] = [];

function stubFetch(o: { dex?: unknown; dexStatus?: number; jup?: unknown; jupStatus?: number }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes("dexscreener")) return new Response(JSON.stringify(o.dex ?? { pairs: [] }), { status: o.dexStatus ?? 200 });
    if (url.startsWith(JUPITER_PRICE_URL)) return new Response(JSON.stringify(o.jup ?? {}), { status: o.jupStatus ?? 200 });
    return new Response("unexpected", { status: 599 });
  }));
}

beforeEach(() => {
  calls.length = 0;
  cache.get.mockReturnValue(undefined);
  owner.classify.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("/api/oracle/resolve without Pyth", () => {
  it("SOL (formerly a pinned Pyth feed) resolves to its DEX pool, keeper-priced; no Pyth anywhere", async () => {
    stubFetch({
      dex: { pairs: [{ chainId: "solana", dexId: "meteora", pairAddress: SOL_POOL, priceUsd: "118", liquidity: { usd: 9e7 }, baseToken: { symbol: "SOL" } }] },
      jup: { [SOL]: { usdPrice: 118.2 } },
    });
    owner.classify.mockResolvedValue({ [SOL_POOL]: "meteora-dlmm" });
    const j = await (await resolve(SOL)).json();
    expect(j).toMatchObject({ feedId: null, source: "dexscreener", oracleMode: "hyperp", dexPoolAddress: SOL_POOL, symbol: "SOL" });
    expect(JSON.stringify(j)).not.toMatch(/pyth/i);
    expect(calls.some((u) => /pyth/i.test(u))).toBe(false);
  });

  it("Jupiter fallback works: DexScreener down -> Jupiter v3 price, admin (no pool)", async () => {
    stubFetch({ dexStatus: 500, jup: { [SOL]: { usdPrice: 117.5 } } });
    const res = await resolve(SOL);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ feedId: null, source: "jupiter", price: 117.5, oracleMode: "admin" });
    expect(calls.some((u) => u.startsWith(`${JUPITER_PRICE_URL}?ids=`))).toBe(true);
  });

  it("NEGATIVE CONTROL: neither source -> 404, never a Pyth guess", async () => {
    stubFetch({ dexStatus: 500, jupStatus: 500 });
    expect((await resolve(SOL)).status).toBe(404);
  });
});

describe("Jupiter Price API v3 reader", () => {
  it("parses the v3 shape; absent / zero / garbage -> null", () => {
    expect(parseJupiterUsdPrice({ [SOL]: { usdPrice: 118.0 } }, SOL)).toBe(118);
    expect(parseJupiterUsdPrice({}, SOL)).toBeNull();
    expect(parseJupiterUsdPrice({ [SOL]: { usdPrice: 0 } }, SOL)).toBeNull();
    expect(parseJupiterUsdPrice({ data: { [SOL]: { price: "118" } } }, SOL)).toBeNull(); // the dead v2 shape
  });
  it("fetches the keyless v3 host; SOL/USD as e6", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ [SOL]: { usdPrice: 118.009638 } }), { status: 200 }));
    expect(await fetchJupiterSolUsdE6(f as unknown as typeof fetch)).toBe(118_009_638n);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`https://lite-api.jup.ag/price/v3?ids=${SOL}`);
    const down = vi.fn(async () => new Response("x", { status: 404 }));
    expect(await fetchJupiterUsdPrice(SOL, down as unknown as typeof fetch)).toBeNull();
  });
});

describe("price-ws SOL/USD: Jupiter, else DEX", () => {
  const dex = vi.fn(async () => 117_000_000n);
  it("fresh Jupiter wins, no RPC", async () => {
    dex.mockClear();
    expect(await pickSolUsdE6({ jupiter: { e6: 118_000_000n, at: 1_000 }, now: 5_000, maxAgeMs: 30_000, dexRead: dex })).toBe(118_000_000n);
    expect(dex).not.toHaveBeenCalled();
  });
  it("missing or stale Jupiter -> the DEX SOL/USDC read", async () => {
    expect(await pickSolUsdE6({ jupiter: null, now: 0, maxAgeMs: 30_000, dexRead: dex })).toBe(117_000_000n);
    expect(await pickSolUsdE6({ jupiter: { e6: 118_000_000n, at: 0 }, now: 60_000, maxAgeMs: 30_000, dexRead: dex })).toBe(117_000_000n);
  });
});

describe("no Hermes / pyth.network in the playground's price paths", () => {
  const read = (f: string) => readFileSync(join(__dirname, "..", "..", f), "utf8");
  it("price-ws, the resolve route and the wizard's detection", () => {
    for (const f of ["scripts/local-price-ws-server.ts", "app/api/oracle/resolve/[ca]/route.ts", "hooks/useQuickLaunch.ts"]) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/hermes|pyth\.network|setOracleType\("pyth"\)|MINT_TO_PYTH/i);
    }
    expect(existsSync(join(__dirname, "..", "..", "hooks", "usePythFeedSearch.ts"))).toBe(false);
    expect(read("components/create/CreateMarketWizard.tsx")).not.toMatch(/case "pyth":/);
  });
});
