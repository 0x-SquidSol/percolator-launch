/**
 * Converting a Supabase NUMERIC column to a bigint — the single definition.
 *
 * `market_stats.total_open_interest`, `open_interest_long/short` and
 * `volume_24h` are Postgres NUMERIC (supabase/migrations/005, 007), so a value
 * from them is not guaranteed to be an integer, and `BigInt()` throws
 * `RangeError` on a non-integer number.
 *
 * `volume_24h` is the field that genuinely carries fractions: the indexer
 * computes it as `SUM(ABS(size::numeric) * price::numeric / 1e6)::text` and
 * supabase-js returns NUMERIC as a string (GH#1494), so "1234.56" is its
 * ordinary shape. The OI columns are safe for a different reason — the markets
 * API overwrites them from on-chain `Number(bigint)` values, which are always
 * integral, and they are not even SELECTed from Postgres (lib/market-registry.ts).
 *
 * The markets page did this conversion in FIVE places — two sort keys and three
 * display values — and they did not agree: the sort keys floored (one of them
 * not at all), the display values rounded. Same column, two answers, so a
 * fractional 99.6 would show as 100 and sort as 99.
 *
 * Copying the guard to the unguarded site would have fixed that instance and
 * left five conversions with nothing keeping them in step. One function instead.
 *
 * No current writer produces a fractional value in those columns and no live
 * market has one, so this is hardening rather than a fix for an observed crash.
 */

/**
 * A NUMERIC column as a non-negative bigint.
 *
 * Floors rather than rounds: these are token base-unit counts, and reporting
 * more open interest than exists is the worse direction to be wrong in.
 *
 * Returns 0n for anything `BigInt()` would have thrown on. It throws three
 * different errors across those inputs — TypeError for null and undefined,
 * RangeError for a non-integer number / NaN / Infinity, SyntaxError for a
 * non-numeric string — and none is worth surfacing as a crashed page for a
 * sort key.
 */
export function numericToBigInt(v: number | string | null | undefined): bigint {
  if (typeof v === "string") {
    // Parsed AS A STRING, deliberately not via Number(). supabase-js returns
    // NUMERIC as a string precisely to preserve precision past 2^53, and
    // Number() throws exactly that away: "12801547564123456789" round-trips as
    // 12801547564123457536, off by 1747. Taking the digits before the decimal
    // point is both exact and the floor we want.
    //
    // parseInt is NOT an option here: it reads "1e18" as 1.
    const digits = /^\s*([+-]?\d+)(?:\.\d+)?\s*$/.exec(v);
    if (digits) {
      const whole = BigInt(digits[1]);
      return whole > 0n ? whole : 0n;
    }
    // Exponent notation ("1e18" — how JS serialises large numerics) and
    // anything malformed fall through to the numeric path, which floors valid
    // values and rejects the rest.
  }
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.floor(n));
}

/**
 * Above this, a Supabase-reported value is a u64 sentinel (uninitialised
 * on-chain state) rather than a real quantity.
 *
 * Exported because the markets page applied it to the OI sort and to the OI and
 * volume DISPLAY, but not to the volume SORT — so a sentinel volume sorted to
 * the top of the table while rendering as "—". Keeping the threshold with the
 * conversion is what stops the next caller from forgetting it.
 *
 * NOTE (not changed here): this 1e18 threshold disagrees with lib/health.ts's
 * own `isSentinelNum` (5e17) and with `U64_SENTINEL_THRESHOLD` (1.8e19) used by
 * sanitizeOnChainValue — so getOI's on-chain branch keeps a value its Supabase
 * branch would zero. Worth one pass to reconcile; out of scope for this one.
 */
export const SUPABASE_SENTINEL_THRESHOLD = 1e18;

export function isSupabaseSentinel(v: number | string | null | undefined): boolean {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) && n > SUPABASE_SENTINEL_THRESHOLD;
}

/** Just the fields openInterestOf reads — keeps this out of the page's types. */
export interface OpenInterestSource {
  onChain?: { configV17?: unknown; engine: { totalOpenInterest?: bigint | null } } | null;
  supabase?: {
    total_open_interest?: number | string | null;
    open_interest_long?: number | string | null;
    open_interest_short?: number | string | null;
  } | null;
}

/**
 * A market's open interest in base units, for sorting and display.
 *
 * Extracted from markets/page.tsx because it was untestable there: the page is
 * 1200 lines, its inner component is not exported, and it needs four data hooks
 * plus a Next navigation context to render. The practical consequence was that
 * reverting the whole conversion fix left the 3687-test suite bit-identical —
 * the helper had tests, the thing that used it had none.
 *
 * `sanitize` is injected rather than imported so this module stays free of the
 * health/on-chain layer; the page passes lib/health's sanitizeOnChainValue.
 */
export function openInterestOf(
  m: OpenInterestSource,
  sanitize: (v: bigint) => bigint,
): bigint {
  // v17 discovery carries no engine state — fall through to the Supabase branch.
  if (m.onChain && !m.onChain.configV17) {
    return sanitize(m.onChain.engine.totalOpenInterest ?? 0n);
  }
  const supaOI =
    m.supabase?.total_open_interest ??
    numericSum(m.supabase?.open_interest_long, m.supabase?.open_interest_short);
  return isSupabaseSentinel(supaOI) ? 0n : numericToBigInt(supaOI);
}

/**
 * Adds two NUMERIC columns numerically.
 *
 * The page did `(long ?? 0) + (short ?? 0)`, which CONCATENATES when supabase-js
 * hands the columns back as strings — "100" + "200" is "100200", a 334x
 * inflation. That is the documented GH#1494 failure mode on these exact
 * columns. It is not reachable through /api/markets today, which coerces both
 * fields before responding, but the expression itself is one raw-row read away
 * from it and costs nothing to make safe.
 */
function numericSum(a: number | string | null | undefined, b: number | string | null | undefined): number {
  const na = typeof a === "string" ? Number(a) : (a ?? 0);
  const nb = typeof b === "string" ? Number(b) : (b ?? 0);
  return (Number.isFinite(na) ? na : 0) + (Number.isFinite(nb) ? nb : 0);
}
