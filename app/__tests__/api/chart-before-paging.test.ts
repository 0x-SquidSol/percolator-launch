/**
 * Tests for /api/chart/[mint]'s `before` (scroll-back paging) support — #2581.
 *
 * GeckoTerminal's OHLCV endpoint accepts `before_timestamp` and pages
 * straight past the single window this route used to fetch. These tests
 * cover the three things that make paging actually work and not silently
 * corrupt or waste the shared GeckoTerminal quota (#2578):
 *
 *   1. A valid `before` is forwarded as `before_timestamp`.
 *   2. An invalid/malformed `before` is ignored (falls back to page 1)
 *      rather than erroring or passing garbage upstream.
 *   3. `before` joins the in-process cache key, so a page-2 request can
 *      never be served page-1's cached bars (or vice versa) — and a
 *      `before` (historical) response is cached far more aggressively than
 *      a page-1 (live) one, since historical bars are immutable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";
import { GET } from "../../app/api/chart/[mint]/route";

type GeckoOhlcvBar = [number, number, number, number, number, number];

function freshMint(): string {
  return Keypair.generate().publicKey.toBase58();
}

/** Builds a fetch mock that resolves `mint` to `pool`, then serves OHLCV bars
 *  keyed by the `before_timestamp` query param the ohlcv request carries
 *  ("none" when absent). */
function makeGeckoFetchMock(pool: string, barsByBeforeParam: Record<string, GeckoOhlcvBar[]>) {
  return vi.fn(async (url: string) => {
    if (url.includes("include=top_pools")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { relationships: { top_pools: { data: [{ id: `solana_${pool}` }] } } },
          included: [{ id: `solana_${pool}`, attributes: { address: pool } }],
        }),
      } as unknown as Response;
    }
    // OHLCV request
    const parsed = new URL(url);
    const beforeParam = parsed.searchParams.get("before_timestamp") ?? "none";
    const bars = barsByBeforeParam[beforeParam] ?? [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { attributes: { ohlcv_list: bars } } }),
    } as unknown as Response;
  });
}

function makeReq(mint: string, params: string): NextRequest {
  return new NextRequest(`http://localhost/api/chart/${mint}?${params}`);
}

async function callRoute(mint: string, params: string) {
  const req = makeReq(mint, params);
  return GET(req, { params: Promise.resolve({ mint }) });
}

describe("GET /api/chart/[mint] — before (scroll-back paging)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards a valid `before` as before_timestamp to GeckoTerminal", async () => {
    const mint = freshMint();
    const pool = freshMint();
    const fetchMock = makeGeckoFetchMock(pool, {
      none: [[2000, 10, 11, 9, 10.5, 100]],
      "1700000000": [[1000, 9, 10, 8, 9.5, 90]],
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await callRoute(mint, "timeframe=day&aggregate=1&limit=365&before=1700000000");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candles).toHaveLength(1);
    expect(body.candles[0].timestamp).toBe(1000 * 1000);

    const ohlcvCall = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.includes("/ohlcv/"));
    expect(ohlcvCall).toBeDefined();
    expect(ohlcvCall).toContain("before_timestamp=1700000000");
  });

  it("ignores a non-numeric `before` and requests page 1 (no before_timestamp)", async () => {
    const mint = freshMint();
    const pool = freshMint();
    const fetchMock = makeGeckoFetchMock(pool, {
      none: [[2000, 10, 11, 9, 10.5, 100]],
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await callRoute(mint, "timeframe=day&aggregate=1&limit=365&before=not-a-number");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candles).toHaveLength(1);

    const ohlcvCall = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.includes("/ohlcv/"));
    expect(ohlcvCall).not.toContain("before_timestamp");
  });

  it("ignores a zero/negative `before` and requests page 1", async () => {
    // A distinct mint/pool per bad value — otherwise the SECOND request hits
    // the (correctly-working) page-1 cache entry the first one just wrote
    // (both "0" and "-5" collapse to "no before"), and never calls fetch()
    // at all, which would make this a test of caching, not validation.
    for (const bad of ["0", "-5"]) {
      const mint = freshMint();
      const pool = freshMint();
      const fetchMock = makeGeckoFetchMock(pool, { none: [[2000, 10, 11, 9, 10.5, 100]] });
      vi.stubGlobal("fetch", fetchMock);

      const res = await callRoute(mint, `timeframe=day&aggregate=1&limit=365&before=${bad}`);
      expect(res.status).toBe(200);
      const ohlcvCall = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.includes("/ohlcv/"));
      expect(ohlcvCall).toBeDefined();
      expect(ohlcvCall).not.toContain("before_timestamp");
    }
  });

  it("keys the in-process cache by `before` — page 2 never serves page 1's bars, or vice versa", async () => {
    const mint = freshMint();
    const pool = freshMint();
    const fetchMock = makeGeckoFetchMock(pool, {
      none: [[2000, 10, 11, 9, 10.5, 100]],
      "1700000000": [[1000, 9, 10, 8, 9.5, 90]],
    });
    vi.stubGlobal("fetch", fetchMock);

    const page1 = await callRoute(mint, "timeframe=day&aggregate=1&limit=365");
    const page1Body = await page1.json();
    expect(page1Body.candles).toEqual([
      { timestamp: 2000 * 1000, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
    ]);

    const page2 = await callRoute(mint, "timeframe=day&aggregate=1&limit=365&before=1700000000");
    const page2Body = await page2.json();
    expect(page2Body.candles).toEqual([
      { timestamp: 1000 * 1000, open: 9, high: 10, low: 8, close: 9.5, volume: 90 },
    ]);

    // Re-requesting page 1 must still return page 1's bars, not page 2's
    // (i.e. the cache entries never collided/overwrote each other).
    const page1Again = await callRoute(mint, "timeframe=day&aggregate=1&limit=365");
    const page1AgainBody = await page1Again.json();
    expect(page1AgainBody.candles).toEqual(page1Body.candles);
    expect(page1AgainBody.cached).toBe(true); // served from cache, not re-fetched
  });

  it("caches a `before` (historical) response far longer than a page-1 response — CDN headers", async () => {
    const mint = freshMint();
    const pool = freshMint();
    const fetchMock = makeGeckoFetchMock(pool, {
      none: [[2000, 10, 11, 9, 10.5, 100]],
      "1700000000": [[1000, 9, 10, 8, 9.5, 90]],
    });
    vi.stubGlobal("fetch", fetchMock);

    const page1 = await callRoute(mint, "timeframe=day&aggregate=1&limit=365");
    const page1CacheControl = page1.headers.get("cache-control") ?? "";
    // Page 1 is a live window — short s-maxage.
    expect(page1CacheControl).toMatch(/s-maxage=60(?!\d)/);

    const page2 = await callRoute(mint, "timeframe=day&aggregate=1&limit=365&before=1700000000");
    const page2CacheControl = page2.headers.get("cache-control") ?? "";
    // A `before` page is immutable history — much longer s-maxage, and
    // marked immutable so the CDN never revalidates it within that window.
    expect(page2CacheControl).toMatch(/immutable/);
    expect(page2CacheControl).toMatch(/s-maxage=604800(?!\d)/);
  });

  it("a `before` page is still served from cache on a repeat request without a second GeckoTerminal call", async () => {
    const mint = freshMint();
    const pool = freshMint();
    const fetchMock = makeGeckoFetchMock(pool, { "1700000000": [[1000, 9, 10, 8, 9.5, 90]] });
    vi.stubGlobal("fetch", fetchMock);

    await callRoute(mint, "timeframe=day&aggregate=1&limit=365&before=1700000000");
    const ohlcvCallsAfterFirst = fetchMock.mock.calls.filter((c) => (c[0] as string).includes("/ohlcv/")).length;
    expect(ohlcvCallsAfterFirst).toBe(1);

    const second = await callRoute(mint, "timeframe=day&aggregate=1&limit=365&before=1700000000");
    const secondBody = await second.json();
    expect(secondBody.cached).toBe(true);

    const ohlcvCallsAfterSecond = fetchMock.mock.calls.filter((c) => (c[0] as string).includes("/ohlcv/")).length;
    expect(ohlcvCallsAfterSecond).toBe(1); // no new GeckoTerminal call spent
  });
});
