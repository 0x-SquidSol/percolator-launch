/**
 * "WAITING ON PRICE FEED" that never clears, on the create-market wizard.
 *
 * Two independent causes, both of which produce that exact screen and neither
 * of which the user can wait out. See lib/initial-price.ts for the mechanics.
 */

import { describe, expect, it } from "vitest";
import {
  MIN_REPRESENTABLE_PRICE,
  formatResolvedPrice,
  pickInitialPrice,
  toInitialPriceE6,
} from "@/lib/initial-price";

describe("toInitialPriceE6 — a resolved price is not always a usable one", () => {
  it("distinguishes a sub-micro price from a missing one", () => {
    // THE BUG. A pump.fun token at 1e-8 resolves perfectly; the feed is fine.
    // Pre-fix the wizard computed `toE6(0.00000001)` = 0n, failed its
    // non-zero check, and rendered "Waiting on price feed" forever.
    const r = toInitialPriceE6("0.00000001");
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "below-minimum", price: 1e-8 });
  });

  it("reports missing only when there really is no price", () => {
    expect(toInitialPriceE6(null)).toMatchObject({ reason: "missing" });
    expect(toInitialPriceE6("")).toMatchObject({ reason: "missing" });
    expect(toInitialPriceE6("not-a-number")).toMatchObject({ reason: "missing" });
  });

  it("accepts the smallest representable price", () => {
    // Boundary: exactly 1e-6 is the cheapest market an E6 price can express.
    expect(toInitialPriceE6(String(MIN_REPRESENTABLE_PRICE))).toEqual({ ok: true, e6: 1n });
  });

  it("rejects just below the boundary rather than rounding it to zero", () => {
    expect(toInitialPriceE6("0.0000009")).toMatchObject({ reason: "below-minimum" });
  });

  it("CONTROL: ordinary prices still convert exactly", () => {
    // Without this, "reject small prices" could be implemented as "reject
    // everything", which would block every launch instead of just the
    // unrepresentable ones.
    expect(toInitialPriceE6("1")).toEqual({ ok: true, e6: 1_000_000n });
    expect(toInitialPriceE6("0.2417")).toEqual({ ok: true, e6: 241_700n });
    expect(toInitialPriceE6("0.000003655")).toEqual({ ok: true, e6: 4n });
    expect(toInitialPriceE6("64250.5")).toEqual({ ok: true, e6: 64_250_500_000n });
  });
});

describe("pickInitialPrice — a later null must not erase a known price", () => {
  it("keeps the pool price when the oracle route returns nothing", () => {
    // THE OTHER BUG. /api/oracle/resolve answers 200 with `price: 0` when both
    // of its upstreams fail, so adminPrice is null while the pool price is
    // good. The wizard assigned that null straight over the good value on its
    // way to step 2, and nothing ever put it back.
    expect(pickInitialPrice("0.25", null, "0.25")).toBe("0.25");
  });

  it("keeps whatever is already held when both sources come back empty", () => {
    expect(pickInitialPrice("0.25", null, null)).toBe("0.25");
  });

  it("prefers the oracle price, which is what the keeper will push", () => {
    expect(pickInitialPrice("0.10", "0.30", "0.20")).toBe("0.30");
  });

  it('treats a formatted-to-zero string as no price at all', () => {
    // "0.000000" is what toFixed(6) makes of a sub-micro price. It must not
    // win over a source still holding the real number.
    expect(pickInitialPrice(null, "0.000000", "0.00000001")).toBe("0.00000001");
  });

  it("returns null only when nothing anywhere has a price", () => {
    expect(pickInitialPrice(null, null, null)).toBeNull();
    expect(pickInitialPrice("", "", "")).toBeNull();
  });

  it("CONTROL: a genuinely better price still replaces the old one", () => {
    // Without this, "never downgrade" could be implemented as "never change",
    // pinning the first price ever seen and ignoring the real feed.
    expect(pickInitialPrice("0.10", "0.99", null)).toBe("0.99");
  });
});

describe("formatResolvedPrice — carrying a price without destroying it", () => {
  it("preserves a sub-micro price instead of flattening it to 0.000000", () => {
    // `(1e-8).toFixed(6)` is "0.000000" — a working feed, rendered
    // indistinguishable from a broken one.
    expect((1e-8).toFixed(6)).toBe("0.000000"); // the old behaviour, pinned
    expect(Number.parseFloat(formatResolvedPrice(1e-8)!)).toBe(1e-8);
  });

  it("round-trips ordinary prices unchanged", () => {
    expect(Number.parseFloat(formatResolvedPrice(0.2417)!)).toBe(0.2417);
    expect(Number.parseFloat(formatResolvedPrice(64250.5)!)).toBe(64250.5);
  });

  it("returns null for a non-price", () => {
    expect(formatResolvedPrice(0)).toBeNull();
    expect(formatResolvedPrice(-1)).toBeNull();
    expect(formatResolvedPrice(Number.NaN)).toBeNull();
  });
});
