import { type NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  parseEngine,
  isV17Account,
  parseMarketGroupV17OI,
  isV17MarketAccount,
} from "@percolatorct/sdk";
import { validateSlabParam } from "@/lib/route-validators";
import { isBlockedSlab } from "@/lib/blocklist";
import { getServerConnection } from "@/lib/server-rpc";

export const dynamic = "force-dynamic";

/**
 * GET /api/open-interest/[slab]
 *
 * Read on-chain only: fetch the slab account via RPC and parse its OI.
 * Returns { totalOi, longOi, shortOi, netLpPosition, historicalOi: [] }. Historical data is
 * omitted (the card skips the bar section when historicalOi is empty).
 *
 * The percolator-api fallback is gone (that service is retired: "Application not found").
 *  - no account / a v17 account that is not a market -> 404
 *  - RPC failure or an OI parse failure             -> 503 (degraded; the card falls back to the
 *    on-chain engine OI it already holds rather than trusting a fabricated $0)
 *  - 404 for blocked slabs (GH#1462)
 *
 * MEDIUM-003: slab parameter validated before any downstream use.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> },
) {
  const { slab } = await params;

  // Validate slab parameter format
  const validation = validateSlabParam(slab);
  if (!validation.valid) {
    return validation.response;
  }
  const validSlab = validation.slab;

  // Blocklist check — short-circuit before hitting the chain.
  if (isBlockedSlab(validSlab)) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  // ── Read OI directly from chain ──────────────────────────────────────────
  try {
    const connection = getServerConnection("confirmed");
    const slabPk = new PublicKey(validSlab);
    const info = await connection.getAccountInfo(slabPk, "confirmed");

    if (!info) {
      // Account doesn't exist on-chain.
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    const bytes = new Uint8Array(info.data);

    // v17 market group accounts (PERCV16\0 magic) use a completely different layout
    // from v12 slabs. Parse OI directly from per-asset slot fields when the account
    // is a market (kind=1). A v17 account that is not a market has no OI (404); a parse
    // failure is answered with the degraded 503 below. Neither is a 200 of zeros, which
    // read as a real "$0 OI / Balanced" market.
    if (isV17Account(bytes)) {
      if (!isV17MarketAccount(bytes)) {
        return NextResponse.json({ error: "Market not found" }, { status: 404 });
      }
      try {
        const oi = parseMarketGroupV17OI(bytes);
        const totalOi = oi.totalLongOiQ + oi.totalShortOiQ;
        return NextResponse.json(
          {
            totalOi: totalOi.toString(),
            longOi: oi.totalLongOiQ.toString(),
            shortOi: oi.totalShortOiQ.toString(),
            // v17 does not aggregate net LP position server-side — return 0 until
            // per-portfolio accumulation is implemented. The client hides this
            // field entirely (rather than showing a fabricated $0) once it sees
            // isV17: true below — see OpenInterestCard.tsx.
            netLpPosition: "0",
            insuranceBalance: oi.insuranceBalance.toString(),
            historicalOi: [],
            // H12: totalOi/longOi/shortOi above are base-asset "Q" quantities
            // (fixed-point, scale 1e6), NOT USD atoms like the v12 branch below.
            // The client needs this flag to know to multiply by the live price
            // before formatting as `$` — printing them directly as dollars was
            // the bug (H12).
            isV17: true,
          },
          {
            headers: {
              "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
            },
          },
        );
      } catch (v17Err) {
        console.warn(`[/api/open-interest/${validSlab}] v17 OI parse failed:`, v17Err);
        return degraded(validSlab, "OI parse");
      }
    }

    // v12.x slab — parseEngine gives us longOi / shortOi / netLpPos directly.
    // Unlike v17, these are already collateral-notional (USD) atoms.
    const engine = parseEngine(bytes);
    const longOi = engine.longOi;
    const shortOi = engine.shortOi;
    const totalOi = longOi + shortOi;
    const netLpPosition = engine.netLpPos;

    return NextResponse.json(
      {
        totalOi: totalOi.toString(),
        longOi: longOi.toString(),
        shortOi: shortOi.toString(),
        netLpPosition: netLpPosition.toString(),
        // Historical OI requires correlating funding_history with per-side engine
        // snapshots which aren't stored in the indexer schema.  Return empty so
        // the component renders the current-snapshot bars only.
        historicalOi: [],
        isV17: false,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
        },
      },
    );
  } catch (err) {
    console.warn(`[/api/open-interest/${validSlab}] chain read failed:`, err);
    return degraded(validSlab, "chain read");
  }
}

/**
 * Chain read failed — signal a DEGRADED state, do not fabricate $0.
 * Returning 200 with zeros made a transient RPC failure render as a genuine
 * "$0 OI / Balanced" market. A 5xx lets the client distinguish "temporarily
 * unavailable" from "no open interest": OpenInterestCard already throws on
 * !res.ok and falls back to the real on-chain engine OI, so this restores the
 * correct value instead of a fabricated zero. The zero fields + `unavailable`
 * flag keep the body shape valid for any other consumer.
 */
function degraded(slab: string, what: string): NextResponse {
  console.warn(`[/api/open-interest/${slab}] ${what} failed — returning 503 (degraded)`);
  return NextResponse.json(
    {
      error: "Open interest temporarily unavailable",
      unavailable: true,
      totalOi: "0",
      longOi: "0",
      shortOi: "0",
      netLpPosition: "0",
      historicalOi: [],
    },
    {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
