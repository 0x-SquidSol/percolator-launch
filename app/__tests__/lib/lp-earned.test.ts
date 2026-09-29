import { describe, expect, it } from "vitest";
import {
  estimateLpEarnedSincePar,
  LP_PAR_PRICE_E6,
} from "../../lib/lp-earned";

describe("estimateLpEarnedSincePar", () => {
  it("is zero at exactly par (fresh vault, no fees accrued yet)", () => {
    const r = estimateLpEarnedSincePar(1_000_000n, LP_PAR_PRICE_E6);
    expect(r.earnedAtoms).toBe(0n);
    expect(r.gainPct).toBe(0);
    expect(r.hasGain).toBe(false);
  });

  it("clamps a below-par price to zero — never a phantom loss", () => {
    // LP-vault share price is monotonic, but a legacy/insurance read or rounding
    // wobble must not render as a negative 'earning'.
    const r = estimateLpEarnedSincePar(1_000_000n, 999_000n);
    expect(r.earnedAtoms).toBe(0n);
    expect(r.hasGain).toBe(false);
  });

  it("earns the fee slice at a 5% share price (par-entry position)", () => {
    // Position worth 1.05 USDC now at price 1.05 ⇒ par cost 1.00 ⇒ earned 0.05.
    // value=1_050_000 atoms, price=1_050_000 e6.
    const r = estimateLpEarnedSincePar(1_050_000n, 1_050_000n);
    // 1_050_000 × (1_050_000 − 1_000_000) / 1_050_000 = 50_000 atoms (0.05).
    expect(r.earnedAtoms).toBe(50_000n);
    expect(r.gainPct).toBeCloseTo(5, 6);
    expect(r.hasGain).toBe(true);
  });

  it("scales with position size at the same price", () => {
    const small = estimateLpEarnedSincePar(1_050_000n, 1_050_000n);
    const big = estimateLpEarnedSincePar(10_500_000n, 1_050_000n);
    expect(big.earnedAtoms).toBe(small.earnedAtoms * 10n);
    // pct is a property of price, not size
    expect(big.gainPct).toBeCloseTo(small.gainPct, 9);
  });

  it("is zero for an empty position regardless of price", () => {
    const r = estimateLpEarnedSincePar(0n, 2_000_000n);
    expect(r.earnedAtoms).toBe(0n);
    expect(r.hasGain).toBe(false);
  });

  it("stays in bigint for large atom counts (no float precision loss)", () => {
    // 1,000,000 USDC (1e12 atoms) at a 10% price.
    const value = 1_100_000_000_000n;
    const r = estimateLpEarnedSincePar(value, 1_100_000n);
    // value × (100_000 / 1_100_000) = value/11
    expect(r.earnedAtoms).toBe(value * 100_000n / 1_100_000n);
    expect(r.gainPct).toBeCloseTo(10, 6);
  });
});
