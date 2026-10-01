import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getClientIp } from "@/lib/get-client-ip";
import { createUpstashRateLimiter } from "@/lib/upstash-rate-limit";
import { hasIndexerDb, queryLpVaultPosition, type LpVaultPositionRow } from "@/lib/indexer-db";

/**
 * GET /api/earn/:slab/position/:wallet
 *
 * The Earn LP-vault cost basis the indexer keeps for this wallet on this market
 * (percolator-indexer#207), so the position card can show an EXACT earned
 * figure. Amounts are decimal strings (u128 on-chain).
 *
 * `available: false` means the indexer has no position (never deposited, or the
 * table is not there yet) — the card then shows the figure as unavailable. It
 * never 500s: this is decoration on a card that works without it.
 */
export const dynamic = "force-dynamic";

const RATE_LIMIT = 60;
const rateLimiter = createUpstashRateLimiter({ limit: RATE_LIMIT, windowMs: 60_000, prefix: "rl:earn-position" });

export interface EarnPositionResponse {
  available: boolean;
  basisKnown?: boolean;
  lpShares?: string;
  pendingRedeemShares?: string;
  costBasisAtoms?: string;
  realizedPnlAtoms?: string;
  updatedSlot?: string;
}

const CACHE = { "Cache-Control": "private, max-age=10" };

function toResponse(row: LpVaultPositionRow | null): EarnPositionResponse {
  if (!row) return { available: false };
  return {
    available: true,
    basisKnown: row.basis_known,
    lpShares: row.lp_shares,
    pendingRedeemShares: row.pending_redeem_shares,
    costBasisAtoms: row.cost_basis_atoms,
    realizedPnlAtoms: row.realized_pnl_atoms,
    updatedSlot: row.updated_slot,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slab: string; wallet: string }> },
) {
  const rl = await rateLimiter.check(getClientIp(request));
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const { slab, wallet } = await params;
  let slabKey: string;
  let walletKey: string;
  try {
    slabKey = new PublicKey(slab).toBase58();
    walletKey = new PublicKey(wallet).toBase58();
  } catch {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  if (hasIndexerDb()) {
    try {
      return NextResponse.json(toResponse(await queryLpVaultPosition(slabKey, walletKey)), { headers: CACHE });
    } catch (err) {
      console.warn("[earn-position] indexer-db error:", err instanceof Error ? err.message : String(err));
    }
  }

  try {
    const { getServiceClient, getServerNetwork } = await import("@/lib/supabase");
    // lp_vault_positions is newer than the generated Database types (indexer#207
    // migration), so this one query goes through the untyped client.
    const db = getServiceClient() as unknown as SupabaseClient;
    const { data, error } = await db
      .from("lp_vault_positions")
      .select(
        "registry,market_slab,lp_shares::text,pending_redeem_shares::text,cost_basis_atoms::text," +
        "realized_pnl_atoms::text,basis_known,updated_slot::text",
      )
      .eq("network", getServerNetwork())
      .eq("market_slab", slabKey)
      .eq("user_wallet", walletKey)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json(toResponse((data as unknown as LpVaultPositionRow | null) ?? null), { headers: CACHE });
  } catch (err) {
    console.warn("[earn-position] supabase unavailable:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ available: false } satisfies EarnPositionResponse, { headers: CACHE });
  }
}
