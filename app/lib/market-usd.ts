/**
 * Converting a raw on-chain token amount to USD — the single definition.
 *
 * `/api/markets` and `/api/stats` both do this, and they did it differently:
 * the markets route returned `null` for an unusable value and rounded to 2dp
 * (GH#1618), the stats route returned `0` and did not round.
 *
 * SCOPE, precisely. This unifies the CONVERSION, which is what GH#2676 needed.
 * It does NOT unify the constants: the $1M price cap is still written out in
 * `api/markets/route.ts`, `api/markets/[slab]/route.ts`, `api/stats/route.ts`
 * (twice) and `app/markets/page.tsx`, and `/api/stats`'s unreachable Supabase
 * path still has its own `toUsd`. Those agree with these by coincidence rather
 * than by construction, and collapsing them is a separate change.
 *
 * That divergence is not hypothetical. The dashboard's 24h volume total is
 * supposed to be the sum of the per-market volumes the same user can read in
 * the markets list, and a total that is computed by a second, slightly
 * different function agrees with the list only by luck. GH#2676 is the sharper
 * version of the same hazard: the stats route gave up on the conversion
 * entirely and returned a hard-coded 0, while the markets list showed ~$5.0K
 * across the same rows.
 *
 * So the conversion lives here, once, with the behaviours its issue history
 * bought: GH#1578 (zero is a real value, not "unknown"), GH#1618 (round away
 * IEEE-754 artifacts) and the $10B per-market sanity cap from GH#1154.
 */

import { isSaneMarketValue } from "@/lib/activeMarketFilter";

/** No single market's OI or 24h volume should exceed this. Above it, the input is garbage (GH#1154). */
export const MAX_PER_MARKET_USD = 10_000_000_000;

/**
 * Cap on a per-token price before it is trusted for a USD conversion.
 *
 * Corrupt devnet `last_price` values (e.g. $7.9T/token) multiply small but
 * legitimate token amounts into billions (GH#1191). $1M is the display-layer
 * guard and matches /api/markets' own sanitizePrice cap; the Rust
 * MAX_ORACLE_PRICE enforces $1B on-chain (GH#1321).
 */
export const MAX_SANE_PRICE_USD = 1_000_000;

/** A price that may be trusted for a conversion, or null. */
export function sanitizePriceUsd(price: number | null | undefined): number | null {
  if (price == null || !Number.isFinite(price)) return null;
  return price > 0 && price <= MAX_SANE_PRICE_USD ? price : null;
}

/**
 * A raw token micro-unit amount as USD, or `null` when it cannot be known.
 *
 * `null` and `0` mean different things and callers must keep them apart: `0` is
 * a market that genuinely traded nothing, `null` is a market whose value we
 * cannot compute (no usable price, or a sentinel amount). Summing `null` as `0`
 * silently reports "no volume" for "unknown volume" — the distinction GH#1578
 * was opened about, and the one GH#2676 is a total failure of.
 */
export function rawToUsd(
  raw: number | null | undefined,
  decimals: number | null | undefined,
  priceUsd: number | null | undefined,
): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  // GH#1578: zero is valid and expected — return it without consulting the
  // price, because `isSaneMarketValue` requires v > 0 and would call it null.
  if (raw === 0) return 0;
  if (!isSaneMarketValue(raw)) return null;
  // `decimals ?? 6` substitutes for nullish only, so a NaN decimals survived the
  // clamp (Math.min(Math.max(NaN,0),18) is NaN), 10 ** NaN is NaN, and the cap
  // comparison `usd > MAX` is false for NaN -- so this returned NaN, breaking
  // the `number | null` this function promises. Both call sites happen to
  // pre-sanitize via numericOrNull, so it was latent; a module whose whole
  // premise is being the self-contained definition should not depend on that.
  const d = Math.min(Math.max(Number.isFinite(decimals as number) ? (decimals as number) : 6, 0), 18);
  const p = priceUsd ?? 0;
  if (p <= 0) return null;
  const usd = (raw / 10 ** d) * p;
  // GH#1618: round to 2dp to eliminate IEEE-754 artifacts (e.g. 4620.241999999999).
  return usd > MAX_PER_MARKET_USD ? null : Math.round(usd * 100) / 100;
}
