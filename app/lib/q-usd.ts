import { isSaneMarketValue } from "@/lib/activeMarketFilter";

/**
 * Engine position scale: every v17 size / OI / volume quantity ("Q") is a
 * base-asset amount in fixed point at 1e6, whatever the base mint's decimals —
 * the engine's notional is `size_q * price_e6 / POS_SCALE` (percolator
 * src/lib.rs POS_SCALE = 1_000_000; src/v16.rs trade_notional_floor).
 *
 * The indexer's `market_stats.volume_24h` is `SUM(ABS(trades.size))` of those
 * same Q units (see __tests__/lib/indexer-stats-volume-usd.test.ts), and a
 * trade's recorded fee confirms it: SOL fill size 3_298_097 @ $118.78 carried a
 * $1.1752 fee = 30 bps of 3.298 SOL x $118.78, not of 0.0033 SOL.
 *
 * Dividing by the MINT's decimals instead (the old /api/markets rawToUsd) is
 * right only for 6-decimal mints — SOL (9) came out 1000x too small ($0.40
 * for ~$397 of volume).
 */
export const Q_SCALE = 1_000_000;

/** Cap per-market USD contribution — prevents sentinel leakage ($10B > any real market). */
export const MAX_PER_MARKET_USD = 10_000_000_000;

/**
 * USD value of a Q quantity at `priceUsd`, rounded to cents.
 *
 * - 0 -> 0 (a real, valid zero — no price needed)
 * - null / non-finite / insane raw -> null
 * - no usable price -> null (indeterminate, NOT zero)
 * - above MAX_PER_MARKET_USD -> null (sentinel leakage)
 */
export function qToUsd(
  rawQ: number | null | undefined,
  priceUsd: number | null | undefined,
): number | null {
  if (rawQ == null || !Number.isFinite(rawQ)) return null;
  if (rawQ === 0) return 0;
  if (!isSaneMarketValue(rawQ)) return null;
  const p = priceUsd ?? 0;
  if (!(p > 0) || !Number.isFinite(p)) return null;
  const usd = (rawQ / Q_SCALE) * p;
  // GH#1618: round to 2dp to eliminate IEEE-754 float artifacts.
  return usd > MAX_PER_MARKET_USD ? null : Math.round(usd * 100) / 100;
}
