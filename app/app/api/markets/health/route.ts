import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getConfig } from "@/lib/config";
import { getServerConnection } from "@/lib/server-rpc";
import { getKnownMarketLpCapitals, scanEnabledMarketLpCapitals } from "@/lib/lp-portfolio";
import { decodeMarketHealth, healthBadges, MARKET_HEALTH_SLICE_LEN, MAX_HEALTH_SLABS, parseSlabsParam } from "@/lib/market-health";
import type { MarketHealthRow } from "@/lib/market-health";

/**
 * GET /api/markets/health?slabs=<a>,<b>,…  (max 50)
 *
 * v18 market health for market cards and the trade page: LP depleted, payout
 * haircut, lock reasons (lib/market-health.ts). One getMultipleAccounts with a
 * 3,675-byte dataSlice per market (header + asset slot 0) plus the LP-capital
 * lookup already used by /api/markets. Read-only; never signs.
 */
export const dynamic = "force-dynamic";

const LP_SCAN_TTL_MS = 30_000;

let lpScanCache: { at: number; programId: string; map: Map<string, bigint> } | null = null;

async function lpCapitals(slabs: string[]): Promise<Map<string, bigint>> {
  const connection = getServerConnection("confirmed");
  const known = await getKnownMarketLpCapitals(connection, slabs);
  const missing = slabs.filter((s) => !known.has(s));
  if (missing.length === 0) return known;
  const programId = getConfig().programId;
  if (!lpScanCache || lpScanCache.programId !== programId || Date.now() - lpScanCache.at > LP_SCAN_TTL_MS) {
    lpScanCache = { at: Date.now(), programId, map: await scanEnabledMarketLpCapitals(connection, new PublicKey(programId)) };
  }
  for (const s of missing) {
    const c = lpScanCache.map.get(s);
    if (c != null) known.set(s, c);
  }
  return known;
}

export async function GET(req: NextRequest) {
  const slabs = parseSlabsParam(req.nextUrl.searchParams.get("slabs"));
  if (!slabs) {
    return NextResponse.json({ error: `slabs must be 1-${MAX_HEALTH_SLABS} comma-separated base58 addresses` }, { status: 400 });
  }
  try {
    const connection = getServerConnection("confirmed");
    const programId = getConfig().programId;
    const [res, lp] = await Promise.all([
      connection.getMultipleAccountsInfoAndContext(
        slabs.map((s) => new PublicKey(s)),
        { dataSlice: { offset: 0, length: MARKET_HEALTH_SLICE_LEN }, commitment: "confirmed" },
      ),
      lpCapitals(slabs).catch(() => new Map<string, bigint>()),
    ]);
    const slot = BigInt(res.context.slot);
    const markets: Record<string, MarketHealthRow | null> = {};
    slabs.forEach((slab, i) => {
      const info = res.value[i];
      if (!info || info.owner.toBase58() !== programId || info.data.length < MARKET_HEALTH_SLICE_LEN) {
        markets[slab] = null;
        return;
      }
      try {
        const h = decodeMarketHealth(new Uint8Array(info.data), slot, lp.get(slab) ?? null);
        markets[slab] = {
          lpCapital: h.lpCapital === null ? null : h.lpCapital.toString(),
          lpDepleted: h.lpDepleted,
          payoutHaircutBps: h.payoutHaircutBps,
          openProfitAtoms: h.openProfitAtoms.toString(),
          realizableProfitAtoms: h.realizableProfitAtoms.toString(),
          lockReasons: h.lockReasons,
          badges: healthBadges(h),
        };
      } catch {
        markets[slab] = null;
      }
    });
    return NextResponse.json(
      { slot: res.context.slot, markets },
      { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } },
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
