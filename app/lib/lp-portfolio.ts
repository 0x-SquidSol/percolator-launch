import { Buffer } from "node:buffer";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  parsePortfolioV17,
  V17_PORTFOLIO_ACCOUNT_LEN,
  V17_PORTFOLIO_IDENTITY_TRAILER_LEN,
  decodePortfolioMatcherControl,
} from "@percolatorct/sdk";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import { getMultipleAccountsInfoChunked } from "@/lib/rpc-chunk";

/**
 * On-chain "Market LP" (the v17 LP-portfolio account that backs a market as
 * counterparty) lookup — server-side helper shared by /api/markets and
 * /api/markets/[slab].
 *
 * Why this exists: the `markets_with_stats` Supabase view's `vault_balance`/
 * `c_tot` columns are populated by the indexer's v12 stats collector, which
 * never ran against v17 markets — both columns are NULL for every v17 row,
 * so the "Market LP" stat rendered as "—" everywhere (GH#2334 relabel didn't
 * fix the underlying null source). The real number lives on-chain: each v17
 * market has exactly one standalone portfolio account with an *enabled*
 * PortfolioMatcherConfigV16 — that's the LP acting as AMM counterparty — and
 * its `capital` field (collateral atoms) is the market's real LP backing.
 *
 * Byte layout mirrors hooks/useTrade.ts's v17 trade-account discovery
 * (kept in sync manually — update both if the program layout changes).
 */

/** v17 portfolio account magic (first 8 bytes, little-endian): PERCV16\0 */
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
/** Provenance header offset: HEADER_LEN(16) + provenance.market_group_id(0) */
const PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF = 16;
/** sizeof(PortfolioMatcherConfigV16). */
const PORTFOLIO_MATCHER_CONFIG_LEN = 104;
/**
 * Fixed byte-length of every v18 portfolio account (SDK V17_PORTFOLIO_ACCOUNT_LEN
 * = 9563; was 9347 in v17). Every portfolio account on the wrapper program — LP or
 * trader — is this exact size, so it doubles as a cheap `dataSize` filter for the
 * all-markets scan below. Imported from the SDK so it tracks the layout.
 */

/**
 * True if the account's PortfolioMatcherConfigV16 is enabled.
 *
 * v18: the matcher config is followed by a
 * `V17_PORTFOLIO_IDENTITY_TRAILER_LEN`-byte identity trailer (so it is no longer
 * the final 104 bytes), and its trailing u64 is a packed control word (bit 0 =
 * enabled) rather than a bare 0/1 flag — decoded via the SDK.
 */
function isMatcherEnabled(data: Buffer): boolean {
  const trailerLen = V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
  if (data.length < PORTFOLIO_MATCHER_CONFIG_LEN + trailerLen) return false;
  const off = data.length - PORTFOLIO_MATCHER_CONFIG_LEN - trailerLen;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return decodePortfolioMatcherControl(dv.getBigUint64(off + 96, true)).enabled;
}

/** Parse `capital` (collateral atoms, u128) from a v17 portfolio account. Null on any parse failure. */
function readCapitalSafe(data: Buffer): bigint | null {
  try {
    return parsePortfolioV17(new Uint8Array(data)).capital;
  } catch {
    return null;
  }
}

/**
 * Known LP-portfolio address for a curated (PLAYGROUND_SLAB_META) market —
 * discovered once via getProgramAccounts and hardcoded so the list route can
 * do a single cheap getMultipleAccountsInfo instead of a per-market scan.
 */
export function getKnownLpPortfolioAddress(slab: string): string | null {
  return PLAYGROUND_SLAB_META[slab]?.lp_portfolio_address ?? null;
}

/**
 * Batched real Market-LP lookup for the bulk /api/markets list — one
 * getMultipleAccountsInfo call covering every slab with a *known* curated
 * LP-portfolio address. Slabs without a known address are simply absent from
 * the returned map; callers keep their existing "—" fallback for those
 * (wizard-launched markets — see discoverMarketLpCapital for the per-market
 * scan used on the trade-page detail route instead).
 */
export async function getKnownMarketLpCapitals(
  connection: Connection,
  slabs: string[],
): Promise<Map<string, bigint>> {
  const result = new Map<string, bigint>();
  const entries = slabs
    .map((slab) => ({ slab, addr: getKnownLpPortfolioAddress(slab) }))
    .filter((e): e is { slab: string; addr: string } => !!e.addr);
  if (entries.length === 0) return result;

  try {
    const pubkeys = entries.map((e) => new PublicKey(e.addr));
    // Curated-only today (small, hardcoded), but chunked defensively so this
    // doesn't silently break if the curated list ever grows past 100.
    const infos = await getMultipleAccountsInfoChunked(connection, pubkeys);
    infos.forEach((info, i) => {
      if (!info?.data) return;
      const capital = readCapitalSafe(Buffer.from(info.data));
      if (capital != null) result.set(entries[i].slab, capital);
    });
  } catch {
    // RPC failure — callers keep their existing vault_balance/c_tot fallback.
  }
  return result;
}

/**
 * Batched real Market-LP lookup for EVERY market on the wrapper program,
 * including wizard-launched markets that have no hardcoded
 * `lp_portfolio_address` in PLAYGROUND_SLAB_META (getKnownMarketLpCapitals
 * only covers the curated seeds). One getProgramAccounts scan filtered
 * server-side to portfolio accounts (magic + fixed account length), then the
 * *enabled* LP-matcher ones are selected in-code via `parsePortfolioV17(...)
 * .matcherEnabled` — v18 packs `enabled` into a control bitfield a memcmp can't
 * express — and grouped by `marketGroupId` (== the market's slab address).
 * Unlike discoverMarketLpCapital (one getProgramAccounts call
 * per market), this is a single call that covers all markets at once — safe
 * to call once per /api/markets request.
 */
export async function scanEnabledMarketLpCapitals(
  connection: Connection,
  programId: PublicKey,
): Promise<Map<string, bigint>> {
  const result = new Map<string, bigint>();
  try {
    // v18: the matcher `enabled` flag is now bit 0 of a packed control word, which
    // a memcmp filter can't express (the other bits vary per portfolio). Filter on
    // magic + the fixed account length only, then check `matcherEnabled` per row
    // from the SDK parse below.
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
        { dataSize: V17_PORTFOLIO_ACCOUNT_LEN },
      ],
    });
    for (const { account } of accounts) {
      const data = Buffer.from(account.data);
      try {
        const parsed = parsePortfolioV17(new Uint8Array(data));
        // Only the LP (matcher-enabled) portfolio counts as the market's backing.
        if (!parsed.matcherEnabled) continue;
        const slab = parsed.marketGroupId.toBase58();
        // Guard against a theoretical duplicate-enabled-portfolio-per-market
        // case — never regress an already-found value.
        const existing = result.get(slab);
        if (existing == null || parsed.capital > existing) {
          result.set(slab, parsed.capital);
        }
      } catch {
        // Skip unparsable accounts — never let one bad row break the scan.
      }
    }
  } catch {
    // RPC failure (unsupported on this cluster, rate-limited, etc.) —
    // callers keep their existing vault_balance/c_tot fallback.
  }
  return result;
}

/**
 * Full on-chain LP-portfolio discovery for a single market: scans for the
 * standalone portfolio account with an enabled matcher config (the AMM
 * counterparty). Mirrors hooks/useTrade.ts's v17 trade-account discovery.
 * One getProgramAccounts call — fine for a single market (trade-page detail
 * only; never called per-row from the bulk list).
 */
export async function discoverMarketLpCapital(
  connection: Connection,
  programId: PublicKey,
  marketPk: PublicKey,
): Promise<bigint | null> {
  try {
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
        { memcmp: { offset: PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF, bytes: marketPk.toBase58() } },
      ],
    });
    for (const { account } of accounts) {
      const data = Buffer.from(account.data);
      if (!isMatcherEnabled(data)) continue;
      const capital = readCapitalSafe(data);
      if (capital != null) return capital;
    }
  } catch {
    // Discovery failed (RPC error, unsupported on this cluster, etc.) — caller
    // keeps its existing fallback.
  }
  return null;
}

/**
 * Real Market-LP lookup for a single market: known-address fast path first
 * (one getAccountInfo call for curated seeds), full getProgramAccounts scan
 * otherwise (wizard-launched markets). Used by /api/markets/[slab].
 */
export async function getMarketLpCapital(
  connection: Connection,
  programId: PublicKey,
  slab: string,
): Promise<bigint | null> {
  const known = getKnownLpPortfolioAddress(slab);
  if (known) {
    try {
      const info = await connection.getAccountInfo(new PublicKey(known));
      if (info?.data) {
        const capital = readCapitalSafe(Buffer.from(info.data));
        if (capital != null) return capital;
      }
    } catch {
      // Fall through to the discovery scan below.
    }
  }
  let marketPk: PublicKey;
  try {
    marketPk = new PublicKey(slab);
  } catch {
    return null;
  }
  return discoverMarketLpCapital(connection, programId, marketPk);
}
