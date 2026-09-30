/**
 * The single write that registers a market.
 *
 * WHY THIS EXISTS
 * ---------------
 * Registration used to take two writes to two stores — a Vercel blob for the
 * keeper's list and the `markets` row for metadata — and the one carrying the
 * creator's intent lost. `POST /api/markets` 409s when a row already exists
 * ("Existing metadata is immutable via this endpoint"), the launch flow swallows
 * that as non-fatal, and the indexer's syncMarkets() inserts a row for any slab
 * it discovers within ~60s with `metadata_source` defaulting to 'auto'. The slab
 * exists on chain before the app POSTs, so the indexer usually wins.
 *
 * Measured on the live database 2026-07-30: all 5 market rows had
 * metadata_source='auto'. `POST /api/markets` had never once created a row. Four
 * of the five were unidentified — symbol='UNKNOWN', name='Market 6RobABa7', no
 * pool address — and every row's `deployer` held the sim-USDC MINT rather than a
 * wallet. The race was not occasional; it was the only outcome.
 *
 * This module is the fix. It is called from the registration route AFTER the
 * route has authenticated the request, in one of two modes:
 *
 *   - "admin": the maintainer path (x-admin-secret). May update any row.
 *   - "proof": the creator path. The proof is the market-creation transaction
 *     (lib/keeper-register-memo.ts), which is PUBLIC and can be replayed by
 *     anyone, but only with the exact registration the creator signed. So this
 *     mode may create a row, and may replace an indexer 'auto' guess (the
 *     creator beats the indexer), but it NEVER overwrites a row that is already
 *     creator-registered ('manual'), never re-activates a retired one, and
 *     never changes the price source (pool / CA) a row already has: the first
 *     proof-registered binding wins, and any change goes through the admin path
 *     (security review 2026-09-30, M-1 / M-2).
 *
 * See docs/MARKET-REGISTRATION-SPEC-2026-07-30.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Everything registration writes. Display fields come from the creator. */
export interface RegistrationRow {
  slab_address: string;
  mint_address: string;
  symbol: string;
  name: string;
  decimals: number;
  deployer: string;
  dex_pool_address: string;
  mainnet_ca: string | null;
  oracle_mode: string;
  network: string;
  /** Derived fields from the wizard's buildMarketRegistrationPayload. Null when
   *  re-registering an already-listed market (the retry path has no
   *  CreateMarketParams to derive them from) — see the null-strip below, which
   *  keeps an existing row's values rather than blanking them. */
  oracle_authority?: string | null;
  initial_price_e6?: string | null;
  lp_collateral?: string | null;
  max_leverage?: number | null;
  trading_fee_bps?: number | null;
  logo_url?: string | null;
}

export type UpsertResult =
  /** `keeperActive`: the row is enrolled for pricing after this call. */
  | { ok: true; action: "inserted" | "updated" | "unchanged"; keeperActive: boolean }
  | { ok: false; status: number; error: string; detail?: string };

export type RegistrationMode = "proof" | "admin";

/** Refused on the proof path: the row already has another price source. */
export const PRICE_SOURCE_LOCKED = "This market is already registered with a different price source.";

interface ExistingRow {
  id: string;
  metadata_source: string | null;
  dex_pool_address?: string | null;
  mainnet_ca?: string | null;
  keeper_status?: string | null;
}

/**
 * Postgres/PostgREST error rendered for a log line and for the caller.
 *
 * The first version of this module returned a bare "Failed to register market",
 * which made a real production failure undiagnosable — the launch UI showed
 * that string and the underlying cause (constraint? column? permission?) was
 * nowhere. A generic message is not a safe default when it is the ONLY signal.
 */
function describe(err: { code?: string; message?: string; details?: string; hint?: string } | null): string {
  if (!err) return "unknown error";
  return [err.code && `code=${err.code}`, err.message, err.details, err.hint]
    .filter(Boolean)
    .join(" | ");
}

/**
 * Insert or update the market row.
 *
 *   no row                            -> insert, metadata_source='manual', keeper_status='active'
 *   existing metadata_source='auto'   -> update; the creator beats the indexer's guess
 *   existing metadata_source='manual' -> "admin": update (maintainer fix)
 *                                        "proof": NO write ('unchanged'); the row stays as the
 *                                        creator first registered it (and as a maintainer may
 *                                        have retired it)
 *   "proof" and the row already names a different pool / CA -> 409, no write
 *
 * `keeper_status='active'` is set only by an insert or an update here. The
 * indexer's inserts take the column default ('retired'), so auto-discovery can
 * never enroll a market for pricing.
 */
/**
 * Map the wizard's oracle vocabulary onto the column's.
 *
 * `markets_oracle_mode_check` allows only ('pyth','hyperp','admin'), but the
 * wizard has a fourth type — "keeper" — for DEX-priced markets. On chain that
 * IS an admin-oracle (AUTH_MARK) market whose oracle_authority is delegated to
 * the keeper service, which is why every row written by the indexer, Fauci
 * included, reads 'admin'. So the value is normalised here rather than widening
 * the constraint: 'keeper' is not a distinct oracle mode, it is who holds the
 * authority, and that is already recorded in oracle_authority.
 *
 * This is what made the FIRST live launch fail with a check violation — and,
 * before that, what made POST /api/markets fail 100% of the time rather than
 * merely lose the race with the indexer. It sent this same unmapped value.
 */
function toDbOracleMode(mode: string): string {
  return mode === "keeper" ? "admin" : mode;
}

export async function upsertRegisteredMarketRow(
  supabase: SupabaseClient,
  row: RegistrationRow,
  mode: RegistrationMode,
): Promise<UpsertResult> {
  return upsertOnce(supabase, row, mode, false);
}

async function upsertOnce(
  supabase: SupabaseClient,
  row: RegistrationRow,
  mode: RegistrationMode,
  raced: boolean,
): Promise<UpsertResult> {
  const { data: existingRaw, error: readErr } = await supabase
    .from("markets")
    .select("id, metadata_source, dex_pool_address, mainnet_ca, keeper_status")
    .eq("slab_address", row.slab_address)
    .eq("network", row.network)
    .maybeSingle();

  if (readErr) {
    console.error("[market-registration] read failed:", describe(readErr));
    return {
      ok: false,
      status: 500,
      error: "Failed to read existing market state",
      detail: describe(readErr),
    };
  }

  const existing = (existingRaw ?? null) as ExistingRow | null;

  if (existing && mode === "proof") {
    const pool = existing.dex_pool_address ?? null;
    const ca = existing.mainnet_ca ?? null;
    if ((pool !== null && pool !== row.dex_pool_address) || (ca !== null && ca !== (row.mainnet_ca ?? null))) {
      return { ok: false, status: 409, error: PRICE_SOURCE_LOCKED };
    }
    if (existing.metadata_source === "manual") {
      return { ok: true, action: "unchanged", keeperActive: existing.keeper_status === "active" };
    }
  }

  // Drop null/undefined optional fields before writing. The retry path
  // re-registers an already-listed market and has no CreateMarketParams to
  // derive max_leverage / trading_fee_bps / oracle_authority from, so it sends
  // nulls; writing those would blank a correct row back to nothing. Absent
  // means "leave whatever is there" — on INSERT the column defaults apply.
  const payload: Record<string, unknown> = { metadata_source: "manual", keeper_status: "active" };
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && v !== undefined) payload[k] = v;
  }
  payload.oracle_mode = toDbOracleMode(row.oracle_mode);

  if (!existing) {
    const { error } = await supabase.from("markets").insert(payload as never);
    if (error) {
      // 23505: a concurrent writer (almost always the indexer's discovery pass)
      // inserted between our read and this write. On the proof path, re-run the
      // existing-row rules against what is there now (never a blind update).
      if (error.code === "23505" && mode === "proof" && !raced) {
        return upsertOnce(supabase, row, mode, true);
      }
      if (error.code === "23505" && mode === "proof") {
        return { ok: false, status: 503, error: "The market row changed while registering. Try again." };
      }
      // Admin path: fall through to an update so the metadata still lands.
      if (error.code === "23505") {
        const { error: updErr } = await supabase
          .from("markets")
          .update(payload as never)
          .eq("slab_address", row.slab_address)
          .eq("network", row.network);
        if (updErr) {
          console.error("[market-registration] post-23505 update failed:", describe(updErr));
          return { ok: false, status: 500, error: "Failed to register market", detail: describe(updErr) };
        }
        return { ok: true, action: "updated", keeperActive: true };
      }
      console.error("[market-registration] insert failed:", describe(error));
      return { ok: false, status: 500, error: "Failed to register market", detail: describe(error) };
    }
    return { ok: true, action: "inserted", keeperActive: true };
  }

  const { error: updErr } = await supabase
    .from("markets")
    .update(payload as never)
    .eq("slab_address", row.slab_address)
    .eq("network", row.network);
  if (updErr) {
    console.error("[market-registration] update failed:", describe(updErr));
    return {
      ok: false,
      status: 500,
      error: "Failed to update market registration",
      detail: describe(updErr),
    };
  }
  return { ok: true, action: "updated", keeperActive: true };
}
