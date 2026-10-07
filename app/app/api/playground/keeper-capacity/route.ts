import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getClientIp } from "@/lib/get-client-ip";
import { createUpstashRateLimiter } from "@/lib/upstash-rate-limit";
import { enrollmentCapsFromEnv, readCreatorCapacity } from "@/lib/keeper-enrollment-guard";

/**
 * GET /api/playground/keeper-capacity?wallet=<base58>  (#3320)
 *
 * A creator's live-priced markets and the per-creator ceiling, so the app can say so BEFORE a
 * launch spends anything, and so My Markets stops offering a registration retry the ceiling will
 * refuse. Read with the same filter and caps keeper-register enforces
 * (lib/keeper-enrollment-guard.ts readCreatorCapacity), never a second copy of them.
 *
 *   200 { activeSlabs: string[], max: number, atLimit: boolean }
 *   400 bad wallet · 429 rate limited · 503 count unavailable (callers treat it as unknown)
 *
 * Public data: `deployer` is on every /api/markets row and is the market's on-chain admin. Behind
 * the playground gate like the rest of /api/playground (middleware.ts); not exempt.
 */
export const dynamic = "force-dynamic";

const RATE_LIMIT = 60;
const rateLimiter = createUpstashRateLimiter({ limit: RATE_LIMIT, windowMs: 60_000, prefix: "rl:keeper-capacity" });
const NO_STORE = { "Cache-Control": "no-store" };
const UNAVAILABLE = "Live-price capacity is unavailable right now.";

export async function GET(request: NextRequest) {
  const rl = await rateLimiter.check(getClientIp(request));
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests — max 60 per minute" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": "60" } },
    );
  }

  let wallet: string;
  try {
    wallet = new PublicKey(new URL(request.url).searchParams.get("wallet") ?? "").toBase58();
  } catch {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400, headers: NO_STORE });
  }

  try {
    const { getServiceClient, getServerNetwork } = await import("@/lib/supabase");
    const cap = await readCreatorCapacity(getServiceClient(), { deployer: wallet, network: getServerNetwork() }, enrollmentCapsFromEnv());
    if (!cap.ok) return NextResponse.json({ error: UNAVAILABLE }, { status: 503, headers: NO_STORE });
    return NextResponse.json({ activeSlabs: cap.activeSlabs, max: cap.max, atLimit: cap.atLimit }, { headers: NO_STORE });
  } catch {
    // Supabase not configured, or the client threw: never echo the reason (review M-1).
    return NextResponse.json({ error: UNAVAILABLE }, { status: 503, headers: NO_STORE });
  }
}
