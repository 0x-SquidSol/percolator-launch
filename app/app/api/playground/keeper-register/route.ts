/**
 * POST /api/playground/keeper-register
 *
 * Register a newly-created playground market so the oracle keeper starts pricing it.
 *
 * The keeper (dcccrypto/percolator-oracle-keeper feat/cross-cluster-keeper) runs on a
 * NAT'd Mac mini — it can only make OUTBOUND calls, so this Vercel app can't POST to it
 * directly. Instead this route persists the registration to a Vercel Blob JSON store
 * (see lib/playground-registered-markets.ts); the keeper polls
 * GET /api/playground/registered-markets outbound on its own interval and adds any
 * market it doesn't already know about. v17 has no on-chain feed_id, so this payload
 * is the only place the market↔pool binding is recorded.
 *
 * This route:
 *   1. AUTHENTICATES the caller — see "Authentication (H1)" below. Previously this
 *      route was unauthenticated (only a devnet env gate), so anyone could inject
 *      or repoint any market's pricing pool.
 *   2. Validates the request (devnet-only, pubkey shapes).
 *   3. Resolves the dexType AUTHORITATIVELY by classifying the pool account's
 *      mainnet owner program (CLMM/DLMM/PumpSwap program ids) — the client
 *      string is only a fallback when mainnet RPC is unreachable. This also
 *      verifies the pool actually exists on mainnet before the keeper is
 *      pointed at it.
 *   4. Upserts { slabAddress, marketAddress, poolAddress, dexType, symbol, label,
 *      mainnetCA, collateral, registeredAt } into the blob, keyed by slabAddress.
 *      The registry is capped at MAX_REGISTERED_MARKETS entries (oldest evicted
 *      first) — see lib/playground-registered-markets.ts.
 *   5. Returns { ok: true, registered: true, ... } on success, or a 502 with a clear
 *      message if the Blob write fails (never throws uncaught — market creation
 *      itself already landed on-chain regardless of this route's outcome).
 *
 * Authentication (UX WP-7, 2026-09-30 — SECURITY REVIEW REQUIRED before merge): two paths —
 *   a) Creation-transaction proof: `proofTx` is the signature of the market's M1 transaction.
 *      That transaction carries an SPL Memo `percolator:keeper-register:v1:<sha256(canonical
 *      params)>` signed by the creator (lib/keeper-register-memo.ts). The route fetches it and
 *      accepts only if it succeeded, the memo matches THIS request's parameters exactly (slab,
 *      pool, CA, dex type, symbol, label), and the memo's signer is the market's creator: the
 *      admin of an InitMarket for this slab in the same tx, or (P3) the vault's on-chain
 *      junior_owner. A stranger cannot repoint a market (they cannot put a memo in the
 *      creator's tx), the creator needs no extra wallet prompt, and there is no replay window or
 *      server nonce. This REPLACES the H1v2 signed-message proof (`deployer` + `signature`).
 *      Because the proof is historical, the call no longer has to happen before StakeInitPool
 *      rotates marketauth.
 *   b) Admin bypass: header `x-admin-secret` matching ADMIN_API_SECRET (maintainer fixes).
 *
 * Body: {
 *   slabAddress:    string  — devnet market account
 *   mainnetCA:      string  — mainnet token CA (for keeper labelling)
 *   dexPoolAddress: string  — mainnet DEX pool address
 *   dexType:        string  — hint; DexScreener dexIds accepted ("meteora",
 *                             "raydium", …) — see lib/dex-type.ts
 *   symbol?:        string  — token symbol (e.g. "SOL")
 *   label?:         string  — human label (e.g. "SOL/USDC — Raydium CLMM")
 *   proofTx?:       string  — required unless using the admin bypass: the market's
 *                             creation-tx signature (see Authentication above)
 * }
 *
 * Environment:
 *   BLOB_READ_WRITE_TOKEN — read automatically by the @vercel/blob SDK (Vercel-managed).
 *   ADMIN_API_SECRET      — optional; enables the admin-bypass auth path (H1b).
 */

import { NextRequest, NextResponse } from "next/server";
import { checkAdminSecret } from "@/lib/admin-secret";
import { verifyKeeperRegisterProofTx } from "@/lib/keeper-register-memo";
import { UNSUPPORTED_POOL_COPY } from "@/lib/wizard-copy";
import { deriveVaultLpState } from "@/lib/limits/p3-ix";
import { decodeVaultLpState } from "@/lib/limits/decode";
import { PublicKey } from "@solana/web3.js";
import * as Sentry from "@sentry/nextjs";
import type { RegisteredMarket } from "@/lib/playground-registered-markets";
import { upsertRegisteredMarket } from "@/lib/playground-registered-markets";
import { KEEPER_DEX_TYPES, type KeeperDexType } from "@/lib/dex-type";
import { classifyPoolsByOwner, type PoolClass } from "@/lib/dex-pool-owner";
import { getConfig, getAllProgramIds } from "@/lib/config";
import { getServerConnection } from "@/lib/server-rpc";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { resolveTokenLogo } from "@/lib/token-logo";
import { sanitizeLogoUrl } from "@/lib/token-metadata-validators";
import { upsertRegisteredMarketRow, type RegistrationRow } from "@/lib/market-registration";
import { checkSymbol, checkName } from "@/lib/market-metadata-validation";

export const dynamic = "force-dynamic";

/** Timing-safe admin-bypass check (H1b) — same secret/header convention as
 *  /api/oracle/set-price-cap. Empty/unset ADMIN_API_SECRET always denies. */
function isAdminBypass(req: NextRequest): boolean {
  return checkAdminSecret(req, "register");
}

async function classifyPoolByOwner(
  poolAddress: string,
): Promise<PoolClass | "rpc-failed"> {
  const r = await classifyPoolsByOwner([poolAddress]);
  if (!r) return "rpc-failed";
  return r[poolAddress] ?? "missing";
}

const NETWORK = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ?? process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();

// Alias-tolerant: the wizard passes DexScreener dexIds ("meteora", "raydium")
// which normalizeDexType maps into the keeper vocabulary. Rejecting raw ids
// here silently orphaned every Meteora/Raydium-pool market (no keeper price,
// no name, invisible on /markets) because the wizard treats registration
// failures as non-fatal.

/** sim-USDC — the single collateral mint shared by every playground market. */
const PLAYGROUND_COLLATERAL_MINT = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";

export async function POST(req: NextRequest) {
  if (NETWORK !== "devnet") {
    return NextResponse.json({ error: "Only available on devnet" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { slabAddress, mainnetCA, dexPoolAddress, dexType, symbol, label, proofTx, deployer, payload } = body as {
    slabAddress?: string;
    mainnetCA?: string;
    dexPoolAddress?: string;
    dexType?: string;
    symbol?: string;
    label?: string;
    proofTx?: string;
    /** Admin bypass only: the market's deployer to record (maintainer re-registration). Not auth. */
    deployer?: string;
    /** Full markets-row payload from the wizard's buildMarketRegistrationPayload.
     *  Absent on the retry path, which re-registers an already-listed market. */
    payload?: Record<string, unknown> | null;
  };

  if (!slabAddress) return NextResponse.json({ error: "slabAddress required" }, { status: 400 });
  if (!dexPoolAddress) return NextResponse.json({ error: "dexPoolAddress required" }, { status: 400 });

  // Validate addresses
  try { new PublicKey(slabAddress); } catch {
    return NextResponse.json({ error: "Invalid slabAddress" }, { status: 400 });
  }
  try { new PublicKey(dexPoolAddress); } catch {
    return NextResponse.json({ error: "Invalid dexPoolAddress" }, { status: 400 });
  }
  if (mainnetCA) {
    try { new PublicKey(mainnetCA); } catch {
      return NextResponse.json({ error: "Invalid mainnetCA" }, { status: 400 });
    }
  }

  // SEC: validate all caller-supplied metadata BEFORE it can reach the markets
  // DB row (upsertRegisteredMarketRow) or the Blob registry
  // (upsertRegisteredMarket). `symbol`/`label` (body) and `payload.symbol`/
  // `payload.name` are attacker-controllable and are rendered as the market's
  // identity across the UI; without this, deceptive names (homoglyph / RTL /
  // zero-width), control characters, or overlong values could impersonate a
  // real market. This mirrors the guards the removed POST /api/markets path
  // enforced (see lib/market-metadata-validation). Server-derived fallbacks
  // ("UNKNOWN", the derived label, `Market <slab>`) are safe and unvalidated;
  // the retry path sends nulls here and is unaffected.
  {
    const payloadMeta = (payload ?? {}) as Record<string, unknown>;
    const metaFields: Array<[unknown, "symbol" | "name"]> = [
      [symbol, "symbol"],
      [payloadMeta.symbol, "symbol"],
      [label, "name"],
      [payloadMeta.name, "name"],
    ];
    for (const [raw, kind] of metaFields) {
      if (typeof raw === "string" && raw.length > 0) {
        const res = kind === "symbol" ? checkSymbol(raw) : checkName(raw);
        if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
      }
    }
  }

  // H1: authenticate the caller before any mainnet RPC or registry write — this
  // route used to be reachable by anyone with a slabAddress, letting a griefer
  // inject or repoint any market's pricing pool. Two accepted paths (see the
  // file header doc comment): admin bypass, or wallet-signed proof that the
  // caller actually administers this specific slab.
  // Kick the logo lookup off NOW, before the two RPC round-trips below (slab
  // ownership + pool classification), so it overlaps them instead of adding its
  // own latency. It used to run just before the DB write, where its two
  // sequential 5s-timeout fetches could add up to 10s to a launch — and this
  // route is awaited between M3a and M4, so that delay was on the critical path.
  // Deliberately not awaited here; see the bounded await at the write.
  const logoPromise: Promise<string | null> = mainnetCA
    ? resolveTokenLogo(mainnetCA).catch(() => null)
    : Promise.resolve(null);

  // The slab's on-chain admin/marketauth, captured by the ownership check below
  // so the registration write can record who actually administers this market.
  let slabAdmin: string | null = null;

  if (!isAdminBypass(req)) {
    // UX WP-7 (SECURITY REVIEW REQUIRED before merge): the creator proves the registration with
    // the transaction that CREATED the market. Its M1 carries an SPL Memo, signed by the creator,
    // binding exactly these parameters (lib/keeper-register-memo.ts). This REPLACES the H1v2
    // signed-message proof (no signMessage prompt, no replay window, no parallel user auth path;
    // the admin bypass above stays the maintainer path).
    if (!proofTx || typeof proofTx !== "string") {
      return NextResponse.json({ error: "Missing required field: proofTx (the market-creation transaction signature)" }, { status: 400 });
    }
    try {
      const connection = getServerConnection("confirmed");
      const slabPubkey = new PublicKey(slabAddress);
      const accountInfo = await connection.getAccountInfo(slabPubkey);
      if (!accountInfo) {
        return NextResponse.json({ error: "Slab account does not exist on-chain" }, { status: 400 });
      }
      const programIds = getAllProgramIds();
      if (!programIds.includes(accountInfo.owner.toBase58())) {
        return NextResponse.json({ error: "Slab account not owned by a known percolator program" }, { status: 400 });
      }
      // P3: the vault's on-chain junior owner is the creator too (accepted when the memo is not in
      // the InitMarket tx itself).
      let juniorOwner: string | null = null;
      try {
        const st = await connection.getAccountInfo(deriveVaultLpState(accountInfo.owner, slabPubkey));
        const decoded = st ? decodeVaultLpState(new Uint8Array(st.data)) : null;
        juniorOwner = decoded ? new PublicKey(decoded.juniorOwner).toBase58() : null;
      } catch {
        juniorOwner = null;
      }
      const tx = await connection.getTransaction(proofTx, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const verdict = await verifyKeeperRegisterProofTx(
        tx,
        { slabAddress, dexPoolAddress, mainnetCA: mainnetCA ?? "", dexType: dexType ?? "", symbol, label },
        programIds,
        juniorOwner,
      );
      if (!verdict.ok) {
        Sentry.captureMessage("[playground/keeper-register] creation-tx proof refused", {
          level: "warning",
          tags: { endpoint: "/api/playground/keeper-register", auth: "memo-fail" },
          extra: { slabAddress, proofTx, reason: verdict.reason },
        });
        // Not landed yet reads as "not found": the client retries with backoff.
        const status = verdict.reason === "proof transaction not found" ? 409 : 403;
        return NextResponse.json({ error: `Registration proof refused: ${verdict.reason}` }, { status });
      }
      slabAdmin = verdict.creator;
    } catch (err) {
      console.error("[playground/keeper-register] proof check failed:", err instanceof Error ? err.message : String(err));
      return NextResponse.json({ error: "Failed to verify the market-creation proof on-chain" }, { status: 503 });
    }
  }

  // Resolve the dexType from the pool's mainnet owner program ONLY. The client
  // dexType string is a hint and is ignored: it cannot tell Meteora DLMM from
  // DAMM (E2E B21). An unreachable RPC is a retryable 503, never a guess.
  const classified = await classifyPoolByOwner(dexPoolAddress);
  if (classified === "missing") {
    return NextResponse.json(
      { error: `dexPoolAddress ${dexPoolAddress} does not exist on mainnet` },
      { status: 400 },
    );
  }
  if (classified === "unsupported") {
    return NextResponse.json(
      {
        error: UNSUPPORTED_POOL_COPY,
      },
      { status: 400 },
    );
  }
  if (classified === "rpc-failed") {
    // E2E B21: never register a pool whose owner we could not verify. The
    // DexScreener string cannot tell DLMM from DAMM ("meteora" for both), and a
    // wrongly-typed pool leaves the market with no price. Retryable.
    return NextResponse.json(
      { error: "Could not verify the pool on mainnet right now. Try again in a moment." },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
  const normalizedDexType: KeeperDexType = classified;

  // Raydium CLMM is withheld from new markets. THIS is the real gate: the
  // client-side filter (SUPPORTED_DEX_IDS / BLOCKED_DEX_IDS) only shapes the
  // wizard's pool list and can be bypassed by POSTing here directly, whereas
  // `normalizedDexType` above is derived from the pool's on-chain owner
  // program and cannot be spoofed.
  //
  // Why: the keeper cannot yet publish a correct USD price for a Raydium CLMM
  // pool paired against SOL. Raydium orders its mints by PUBKEY and prices
  // "mint1 per mint0", so WSOL lands on either side depending on the other
  // token's address — one side needs a multiply by SOL/USD, the other an
  // invert. Registering such a market publishes a price that is ~80x wrong
  // half the time, which does not just mis-draw the chart: it permanently
  // mis-sizes the LP trade caps written once at market creation (the
  // 2026-07-29 Meteora/WSOL incident had exactly this shape). Lift this once
  // price-reader.ts handles both orientations.
  if (normalizedDexType === "raydium-clmm") {
    return NextResponse.json(
      {
        error:
          "Raydium pools are not supported for new markets yet — the price feed cannot " +
          "yet publish a reliable USD price for Raydium pools paired against SOL. " +
          "Launch against a Pump.fun or Meteora pool instead.",
      },
      { status: 400 },
    );
  }

  const resolvedLabel = label ?? (symbol ? `${symbol}/USDC — ${normalizedDexType}` : `${slabAddress.slice(0, 8)}… — ${normalizedDexType}`);

  const entry: RegisteredMarket = {
    slabAddress,
    marketAddress: slabAddress,
    poolAddress: dexPoolAddress,
    dexType: normalizedDexType,
    symbol: symbol ?? null,
    label: resolvedLabel,
    mainnetCA: mainnetCA ?? null,
    collateral: PLAYGROUND_COLLATERAL_MINT,
    registeredAt: Date.now(),
  };

  // ── The registration write (markets row) ─────────────────────────────────
  // This is the store that matters: the keeper reads keeper_status='active'
  // from here. The blob write below is retained only until the keeper cutover
  // is proven, then removed (rollout step 4). Runs FIRST so a DB failure fails
  // the registration outright rather than leaving the blob ahead of the row.
  //
  // Everything above has already verified the caller against the slab's live
  // on-chain marketauth, so this write is authenticated. See
  // lib/market-registration.ts for why an 'auto' row may be overwritten.
  // `deployer` must be the wallet that ADMINISTERS the market. On the signed
  // path that is the verified deployer (already proven equal to the on-chain
  // marketauth); on the admin-bypass path nobody signed, so fall back to the
  // marketauth read from chain rather than writing something that merely looks
  // plausible. Every pre-existing row has the sim-USDC MINT in this column —
  // that is the mistake this avoids repeating.
  // The creator proven by the creation tx; on the admin (maintainer) path, the deployer it names.
  const registeredDeployer = slabAdmin ?? (isAdminBypass(req) ? deployer ?? null : null);
  if (!registeredDeployer) {
    return NextResponse.json(
      { ok: false, registered: false, error: "Cannot determine the market's deployer" },
      { status: 400 },
    );
  }

  // Prefer the wizard's payload: it is the single source of truth for the
  // DERIVED fields (floored max_leverage, oracle_authority's crank-wallet rule,
  // initial_price_e6, lp_collateral). Falling back to literals here would give
  // every market the column defaults — 10x and 10bps — regardless of what the
  // creator chose. Identity fields stay pinned to values this route has already
  // verified, so a crafted payload cannot repoint the row.
  const p = (payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

  // Resolve the logo HERE, at registration.
  //
  // The indexer's metadata pass is guarded by .eq("metadata_source","auto"), so
  // the moment registration marks a row 'manual' the indexer can never fill in
  // logo_url again. Registration therefore has to supply it, or every properly
  // registered market would show a blank icon while the abandoned placeholder
  // rows kept theirs. Best-effort: a missing logo must never fail a launch.
  // Bounded await: by now the lookup has had the whole auth + classification
  // window to finish, so it is normally already resolved. A slow logo API must
  // never hold up a launch — past the deadline the market registers without one
  // (the success screen offers a manual upload).
  //
  // sanitizeLogoUrl, not the raw value: this string is rendered as an image src,
  // and the removed POST /api/markets path sanitized it before writing.
  const LOGO_DEADLINE_MS = 1_500;
  let resolvedLogo: string | null = null;
  try {
    const raw = await Promise.race([
      logoPromise,
      new Promise<null>((r) => setTimeout(() => r(null), LOGO_DEADLINE_MS)),
    ]);
    resolvedLogo = sanitizeLogoUrl(raw);
  } catch {
    resolvedLogo = null;
  }

  const dbResult = await upsertRegisteredMarketRow(getServiceClient(), {
    slab_address: slabAddress,
    mint_address: str(p.mint_address) ?? PLAYGROUND_COLLATERAL_MINT,
    symbol: str(p.symbol) ?? symbol ?? "UNKNOWN",
    name: str(p.name) ?? label ?? symbol ?? `Market ${slabAddress.slice(0, 8)}`,
    decimals: num(p.decimals) ?? 6,
    deployer: registeredDeployer,
    dex_pool_address: dexPoolAddress,
    mainnet_ca: mainnetCA ?? null,
    oracle_mode: str(p.oracle_mode) ?? "admin",
    network: getServerNetwork(),
    oracle_authority: str(p.oracle_authority),
    initial_price_e6: str(p.initial_price_e6),
    lp_collateral: str(p.lp_collateral),
    max_leverage: num(p.max_leverage),
    trading_fee_bps: num(p.trading_fee_bps),
    logo_url: resolvedLogo,
  });
  if (!dbResult.ok) {
    // Surface the underlying cause. This is a devnet playground and the launch
    // UI is the only place this failure is ever seen — a bare "Failed to
    // register market" left a real production failure with no diagnosable
    // signal anywhere.
    console.error(
      "[playground/keeper-register] markets row write failed:",
      dbResult.error,
      dbResult.detail ?? "(no detail)",
    );
    return NextResponse.json(
      {
        ok: false,
        registered: false,
        error: dbResult.detail ? `${dbResult.error}: ${dbResult.detail}` : dbResult.error,
      },
      { status: dbResult.status },
    );
  }

  try {
    await upsertRegisteredMarket(entry);
  } catch (err) {
    // SEC: log the raw upstream error server-side only. Echoing it to the
    // caller (the previous `detail` field) leaked internal infra text — the
    // @vercel/blob error strings can name store IDs / paths and are an
    // info-leak smell. The generic `error` message is all the client needs.
    console.error(
      "[playground/keeper-register] Blob write failed:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      {
        ok: false,
        registered: false,
        error: "Failed to persist market registration to Blob store",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    // Kept alongside `ok` for backward compatibility with the existing
    // hooks/useCreateMarket.ts caller (registered/message drive its UI copy).
    registered: true,
    message: "Registered — the keeper will pick this up on its next poll (~30s)",
    slabAddress,
    dexPoolAddress,
    dexType: normalizedDexType,
    label: resolvedLabel,
  });
}
