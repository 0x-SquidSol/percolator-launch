/**
 * lib/market-usd — the single raw-to-USD conversion (GH#2676).
 *
 * `/api/markets` and `/api/stats` both convert raw token amounts to USD, and
 * they did it with two private functions that disagreed: one returned `null`
 * for an unusable value and rounded to 2dp, the other returned `0` and did not
 * round. The dashboard total is meant to be the sum of the per-market figures
 * the same user can read, and two implementations agree only by luck.
 *
 * These tests live here rather than in the route tests because this is where
 * the behaviour is. A route that sums the results cannot distinguish `null`
 * from `0` — both contribute nothing to a total — so mutating `null` to `0`
 * survives every route-level assertion. It is `/api/markets`, which publishes
 * the value per row, where the difference is visible to a user.
 */

import { describe, expect, it } from "vitest";
import {
  rawToUsd,
  sanitizePriceUsd,
  MAX_PER_MARKET_USD,
  MAX_SANE_PRICE_USD,
} from "@/lib/market-usd";

describe("rawToUsd", () => {
  it("converts using the market's own decimals", () => {
    // The live SOL market: 9 decimals, not 6. Read as 6 this is ~$401 instead
    // of $0.40 — the 1000x error a uniform-decimals fixture cannot catch.
    expect(rawToUsd(3_396_789, 9, 118.162696)).toBeCloseTo(0.4, 2);
    expect(rawToUsd(3_396_789, 6, 118.162696)).toBeCloseTo(401.37, 2);
  });

  it("reproduces what /api/markets publishes for the live rows", () => {
    // Transcribed from https://percolator-playground.vercel.app/api/markets,
    // 2026-09-28. If this drifts, the protocol total stops matching the list.
    expect(rawToUsd(14_516_316_281, 6, 0.014077)).toBe(204.35);
    expect(rawToUsd(69_707_764_605, 6, 0.01787)).toBe(1245.68);
    expect(rawToUsd(16_511_677_058, 6, 0.150484)).toBe(2484.74);
    expect(rawToUsd(14_032_613_818, 6, 0.078349)).toBe(1099.44);
  });

  it("rounds to 2dp, because summing raw floats reintroduces the artifact", () => {
    // GH#1618. Compare against the SAME arithmetic without the rounding step,
    // rather than asserting a float property of the result: `v * 100` is not
    // reliably integral even for a correctly rounded value.
    const raw = 123_456_789_012, dec = 6, px = 0.0374242;
    const unrounded = (raw / 10 ** dec) * px;
    const v = rawToUsd(raw, dec, px)!;
    expect(v).toBe(Math.round(unrounded * 100) / 100);
    // CONTROL: this input really does produce an artifact, so the assertion
    // above is about the rounding and not a value that was already clean.
    expect(unrounded).not.toBe(Math.round(unrounded * 100) / 100);
    expect(String(v)).not.toMatch(/\.\d{3,}/);
  });

  it("treats a genuine zero as zero, not as unknown", () => {
    // GH#1578: isSaneMarketValue requires v > 0, so a zero-volume market would
    // otherwise be reported as "cannot be known" and vanish from a list.
    expect(rawToUsd(0, 6, 1.23)).toBe(0);
    // ...and it does NOT need a usable price to say so.
    expect(rawToUsd(0, 6, 0)).toBe(0);
    expect(rawToUsd(0, 6, null)).toBe(0);
  });

  it("returns null — not 0 — when the value cannot be known", () => {
    // The distinction the whole module exists for: a market we cannot price is
    // not a market that traded nothing.
    expect(rawToUsd(1_000_000, 6, 0)).toBeNull();
    expect(rawToUsd(1_000_000, 6, null)).toBeNull();
    expect(rawToUsd(null, 6, 1.23)).toBeNull();
    expect(rawToUsd(undefined, 6, 1.23)).toBeNull();
    expect(rawToUsd(Number.NaN, 6, 1.23)).toBeNull();
    expect(rawToUsd(Number.POSITIVE_INFINITY, 6, 1.23)).toBeNull();
  });

  it("rejects a per-market total above the sanity cap", () => {
    // GH#1154: sentinel-like raw values leaked through as $2T.
    // SAME raw magnitude on both sides, so the only thing that differs is
    // whether the RESULT crosses the cap. The previous version compared a
    // 1e15 raw against a 1e9 raw: tightening isSaneMarketValue's sentinel
    // bound rejected the first one earlier and both assertions still passed,
    // so it proved nothing about the cap.
    const raw = 1_000_000_000_000_000; // 1e15, safely under the 1e18 sentinel
    expect(rawToUsd(raw, 6, 1_000)).toBeNull();          // 1e12 -> over the cap
    const justUnder = rawToUsd(raw, 6, 9)!;              // 9e9  -> under it
    expect(justUnder).toBe(9_000_000_000);
    expect(justUnder).toBeLessThan(MAX_PER_MARKET_USD);
    // And the boundary itself is exclusive: exactly the cap is allowed.
    expect(rawToUsd(raw, 6, 10)).toBe(MAX_PER_MARKET_USD);
  });

  it("clamps decimals to a sane range, and the UPPER clamp is observable", () => {
    // `not.toBeNull()` alone cannot see the upper clamp: at 1e6 raw, both an
    // 18 and a 30 clamp round to 0, so the assertion passes either way. Pick a
    // raw where the two genuinely differ -- 1e17 over 10^18 is 0.10, over
    // 10^30 it is 1e-13, which rounds to 0.
    expect(rawToUsd(100_000_000_000_000_000, 99, 1)).toBe(0.1);
    // Lower clamp: -5 clamps to 0, so 1e6 / 10^0 is 1e6. Unclamped it would
    // DIVIDE by 10^-5, i.e. multiply by 1e5, giving 1e11 -- over the value cap
    // and therefore null. So this distinguishes clamped from unclamped.
    expect(rawToUsd(1_000_000, -5, 1)).toBe(1_000_000);
  });

  it("returns null, never NaN, for a non-finite decimals", () => {
    // The signature promises `number | null`. `decimals ?? 6` only substitutes
    // for nullish, so NaN used to flow through the clamp and out as NaN.
    expect(rawToUsd(1_000_000, Number.NaN, 1.5)).not.toBeNull();
    expect(Number.isNaN(rawToUsd(1_000_000, Number.NaN, 1.5) as number)).toBe(false);
    expect(rawToUsd(1_000_000, Number.NaN, 1.5)).toBe(rawToUsd(1_000_000, 6, 1.5));
  });
});

describe("sanitizePriceUsd", () => {
  it("rejects a corrupt devnet price", () => {
    // GH#1191: a $7.9T/token last_price multiplies legitimate amounts into
    // billions. Without this the conversion happily returns a huge number.
    expect(sanitizePriceUsd(7_900_000_000_000)).toBeNull();
    expect(sanitizePriceUsd(MAX_SANE_PRICE_USD + 1)).toBeNull();
  });

  it("keeps a high but legitimate admin-set price", () => {
    // GH#1321: the previous $10K cap rejected real devnet prices (MOLTBOT at
    // $210K). $1M is the display-layer guard.
    expect(sanitizePriceUsd(210_000)).toBe(210_000);
    // HARD LITERALS, not MAX_SANE_PRICE_USD. Asserting against the imported
    // constant is self-referential: it moves with the value, so lowering the
    // cap to e.g. $300K -- silently rejecting legitimate prices -- passed.
    expect(sanitizePriceUsd(999_999)).toBe(999_999);
    expect(sanitizePriceUsd(1_000_000)).toBe(1_000_000);
    expect(sanitizePriceUsd(1_000_001)).toBeNull();
    // CONTROL: the exported constant still agrees with the literals above, so
    // the two cannot drift apart unnoticed.
    expect(MAX_SANE_PRICE_USD).toBe(1_000_000);
  });

  it("rejects non-positive and non-finite prices", () => {
    for (const p of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(sanitizePriceUsd(p as number)).toBeNull();
    }
  });
});
