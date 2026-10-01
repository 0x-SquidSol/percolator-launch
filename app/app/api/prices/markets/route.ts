import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { loadMergedMarketRows } from "@/lib/market-registry";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * GET /api/prices/markets — { [slabAddress]: { priceE6: string } }.
 *
 * Was a proxy to the retired percolator-api /prices/markets. Now built from the same registry +
 * live on-chain read /api/markets uses (lib/market-registry.ts loadMergedMarketRows: only the
 * current wrapper's markets, mark price read from each slab). Price preference unchanged:
 * mark, then last, then index; USD -> e6 integer string.
 */
export async function GET() {
  try {
    const rows = await loadMergedMarketRows();
    if (rows === null) return NextResponse.json({ error: "Market registry unavailable" }, { status: 503, headers: NO_STORE });
    const result: Record<string, { priceE6: string }> = {};
    for (const m of rows) {
      const slab = typeof m.slab_address === "string" ? m.slab_address : null;
      const usd = [m.mark_price, m.last_price, m.index_price].map((v) => (v == null ? null : Number(v))).find((v) => v != null && Number.isFinite(v) && v > 0);
      if (slab && usd != null) result[slab] = { priceE6: Math.round(usd * 1_000_000).toString() };
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err, { tags: { endpoint: "/api/prices/markets" } });
    return NextResponse.json({ error: "Failed to load prices" }, { status: 500, headers: NO_STORE });
  }
}
