/**
 * NUMERIC -> bigint, the conversion the markets page sorts on.
 *
 * The markets page had this twice, twenty lines apart, and only one guarded.
 * Both run inside the sort comparator, so an unguarded fractional row throws
 * during render and takes the whole page with it rather than mis-sorting one
 * entry.
 *
 * This is hardening, not a fix for an observed crash: the columns are Postgres
 * NUMERIC and can hold a fraction, but no current writer produces one and no
 * live market has one. The asymmetry is the part worth removing.
 */

import { describe, expect, it } from "vitest";
import { numericToBigInt, openInterestOf, isSupabaseSentinel } from "@/lib/supabase-numeric";

describe("numericToBigInt", () => {
  it("floors a fractional NUMERIC instead of throwing", () => {
    // The whole point. BigInt(12.5) is a RangeError.
    expect(() => BigInt(12.5)).toThrow(RangeError);
    expect(numericToBigInt(12.5)).toBe(12n);
    expect(numericToBigInt(0.9)).toBe(0n);
  });

  it("floors rather than rounds", () => {
    // These are token base-unit counts; reporting MORE open interest than
    // exists is the worse direction to be wrong in.
    expect(numericToBigInt(99.99)).toBe(99n);
    expect(numericToBigInt(100.5)).toBe(100n);
  });

  it("is exact for the integers every live market actually has", () => {
    expect(numericToBigInt(12_801_547_564)).toBe(12_801_547_564n);
    expect(numericToBigInt(0)).toBe(0n);
  });

  it("is exact ABOVE Number.MAX_SAFE_INTEGER", () => {
    // The test above used to carry a comment claiming it covered "values well
    // past MAX_SAFE_INTEGER" while its fixture, 1.28e10, sits 700,000x BELOW the
    // 9.007e15 bound. Review killed a magnitude-cap mutant with that gap. OI is
    // in token base units, so an 18-decimal mint holding 10 tokens is 1e19 —
    // past the bound is the normal case, not the exotic one.
    expect(numericToBigInt(2 ** 53)).toBe(9_007_199_254_740_992n);
    expect(numericToBigInt(1e16)).toBe(10_000_000_000_000_000n);
    expect(numericToBigInt(1e18)).toBe(1_000_000_000_000_000_000n);
  });

  it("keeps full precision when a NUMERIC arrives as a string", () => {
    // supabase-js returns NUMERIC as a string TO PRESERVE PRECISION, and routing
    // it through Number() throws away exactly that: this value comes back as
    // ...457536, off by 1747. Parsed as digits it is exact.
    const exact = "12801547564123456789";
    expect(numericToBigInt(exact)).toBe(12_801_547_564_123_456_789n);
    // The loss is only visible through BigInt: the decimal literal is itself a
    // double and rounds to the same value, which is how I first wrote this
    // assertion and why it compared a number to itself.
    expect(BigInt(Number(exact))).not.toBe(BigInt(exact));
    expect(BigInt(Number(exact)) - BigInt(exact)).toBe(747n);
    // The fractional part is dropped, not rounded, and precision survives.
    expect(numericToBigInt("12801547564123456789.99")).toBe(12_801_547_564_123_456_789n);
  });

  it("reads exponent notation, which is how JS serialises large numerics", () => {
    // parseInt(\"1e18\", 10) is 1 — a 1e18-fold error that passed every earlier
    // test in this file.
    expect(numericToBigInt("1e18")).toBe(1_000_000_000_000_000_000n);
    expect(numericToBigInt("1e21")).toBe(1_000_000_000_000_000_000_000n);
    // And malformed strings are still rejected rather than half-parsed.
    expect(numericToBigInt("12abc")).toBe(0n);
    expect(numericToBigInt("1,000")).toBe(0n);
  });

  it("returns 0n for every input BigInt() would have thrown on", () => {
    // BigInt throws three different errors across these — TypeError for
    // null/undefined, RangeError for NaN/Infinity, SyntaxError for a
    // non-numeric string — and none should surface as a crashed page.
    for (const bad of [null, undefined, Number.NaN, Infinity, -Infinity, "abc"]) {
      expect(numericToBigInt(bad as never)).toBe(0n);
    }
  });

  it("handles a NUMERIC returned as a string", () => {
    // supabase-js hands back NUMERIC as a string to preserve precision, and
    // volume_24h is exactly that: the indexer computes it as
    // SUM(ABS(size)*price/1e6)::text, so a fractional string is its NORMAL shape.
    //
    // Note which error the old call sites would actually have raised: BigInt()
    // on the bare string is a SyntaxError, but both sites passed it through
    // Math.max/Math.floor first, which coerce to a NUMBER — so the real failure
    // was RangeError on 12.5, not SyntaxError on "12.5". Both are covered here
    // because the helper now takes the string directly.
    expect(() => BigInt("12.5")).toThrow(SyntaxError);
    expect(() => BigInt(Math.max(0, "12.5" as never))).toThrow(RangeError);
    expect(numericToBigInt("12.5")).toBe(12n);
    expect(numericToBigInt("12801547564")).toBe(12_801_547_564n);
  });

  it("clamps negatives to 0n", () => {
    // The old call site did Math.max(0, …) for this; keep it, since a negative
    // open interest is meaningless and would sort below an empty market.
    expect(numericToBigInt(-1)).toBe(0n);
    expect(numericToBigInt(-0.5)).toBe(0n);
  });

  it("a negative value is 0n, which the volume sort treats as absent", () => {
    // Documented because it IS a behaviour change, not just a guard. The volume
    // sort is `numericToBigInt(v) || getOI(a)`: previously a negative volume
    // produced a truthy negative bigint and sorted the market dead last; now it
    // is 0n, which is falsy, so the comparator falls back to open interest.
    // Nonsense input either way, but the fallback is the better answer and the
    // change should not be silent.
    expect(numericToBigInt(-3)).toBe(0n);
    expect(Boolean(numericToBigInt(-3))).toBe(false);
    expect(Boolean(BigInt(Math.floor(-3)))).toBe(true); // the old behaviour
  });

  it("CONTROL: it is not a stub that always returns 0n", () => {
    // Several assertions above expect 0n, so without this a `return 0n` body
    // would satisfy them.
    expect(numericToBigInt(7)).toBe(7n);
    expect(numericToBigInt(7)).not.toBe(numericToBigInt(8));
  });
});

/**
 * openInterestOf — the extracted markets-page sort key.
 *
 * This is the coverage that was missing entirely. Review mutated the call site
 * four ways, including reverting the whole conversion fix and making it return
 * 0n for every Supabase market, and all four survived the full 3687-test suite
 * with a byte-identical failure set. The helper had tests; the thing that used
 * it had none, because it was a closure inside a 1200-line page whose inner
 * component is not exported.
 */
describe("openInterestOf", () => {
  /** The real sanitizer's contract: zero-or-negative and u64 sentinels -> 0n. */
  const sanitize = (v: bigint) => (v <= 0n || v >= 18_000_000_000_000_000_000n ? 0n : v);

  it("prefers on-chain state when the market has it", () => {
    const m = { onChain: { engine: { totalOpenInterest: 500n } }, supabase: { total_open_interest: 999 } };
    expect(openInterestOf(m, sanitize)).toBe(500n);
  });

  it("falls back to Supabase for v17 discovery, which carries no engine state", () => {
    const m = { onChain: { configV17: {}, engine: { totalOpenInterest: 500n } }, supabase: { total_open_interest: 42 } };
    expect(openInterestOf(m, sanitize)).toBe(42n);
  });

  it("does not throw on a fractional Supabase value — the whole point", () => {
    // Inline, this was `BigInt(Math.max(0, supaOI))`, a RangeError inside the
    // sort comparator, i.e. a blank markets page rather than a mis-sorted row.
    const m = { supabase: { total_open_interest: 99.6 } };
    expect(() => openInterestOf(m, sanitize)).not.toThrow();
    expect(openInterestOf(m, sanitize)).toBe(99n);
  });

  it("zeroes a sentinel rather than letting it dominate the sort", () => {
    expect(openInterestOf({ supabase: { total_open_interest: 1.8e19 } }, sanitize)).toBe(0n);
    // CONTROL: just below the threshold is kept, so this is a boundary and not
    // a blanket zero.
    expect(openInterestOf({ supabase: { total_open_interest: 1e18 } }, sanitize)).toBe(1_000_000_000_000_000_000n);
  });

  it("adds long and short NUMERICALLY when the total is absent", () => {
    // `(long ?? 0) + (short ?? 0)` CONCATENATES when supabase-js returns these
    // as strings: "100" + "200" is "100200", a 334x inflation. GH#1494 documents
    // that exact failure mode on these exact columns. Not reachable through
    // /api/markets today, which coerces both fields first — but the expression
    // was one raw-row read away from it.
    expect(openInterestOf({ supabase: { open_interest_long: 100, open_interest_short: 200 } }, sanitize)).toBe(300n);
    expect(openInterestOf({ supabase: { open_interest_long: "100", open_interest_short: "200" } }, sanitize)).toBe(300n);
    expect(openInterestOf({ supabase: { open_interest_long: "9", open_interest_short: null } }, sanitize)).toBe(9n);
  });

  it("CONTROL: it tracks its input rather than returning a constant", () => {
    // Without this, the reductio mutant — `return numericToBigInt(0)` for every
    // Supabase market, which destroys the OI sort outright — would survive, as
    // it did against the entire suite before this file existed.
    expect(openInterestOf({ supabase: { total_open_interest: 7 } }, sanitize)).toBe(7n);
    expect(openInterestOf({ supabase: { total_open_interest: 8 } }, sanitize)).toBe(8n);
    expect(openInterestOf({ supabase: {} }, sanitize)).toBe(0n);
  });

  it("isSupabaseSentinel is a boundary, not a blanket", () => {
    expect(isSupabaseSentinel(1e18)).toBe(false);
    expect(isSupabaseSentinel(1.0001e18)).toBe(true);
    expect(isSupabaseSentinel(null)).toBe(false);
    expect(isSupabaseSentinel("2e19")).toBe(true);
  });
});
