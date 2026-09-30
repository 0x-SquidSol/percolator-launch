// @vitest-environment node
/**
 * The Earn worse-of pricing (percolator-prog ede691b6) — the ONE app port, lib/limits/earn-pricing.ts.
 *  - Rust parity: `vault_lp_senior_pricing_claim` and `vault_lp_recover` vectors from rustc
 *    (fixture rust-p3-final.json, vault_lp_v18.rs unchanged 4b1a5d30..ede691b6).
 *  - `vault_lp_equity_lag_bounds_ro`: per-leg raw |basis|, ceil per side, flat LP, stale => 85.
 *  - 77 / 75 Live composition exactly as the handler; the end-to-end payout parity against the
 *    ede691b6 BPF is `limits_app_worse_of_77_payout_matches_preview` (scripts/limits-parity/p3-sim).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  earnSeniorPricing,
  liveDepositClaim,
  liveRedeemSeniorValue,
  riskNotionalCeil,
  seniorPricingClaim,
  vaultLpEquityLagBounds,
  type LagBoundsLp,
  type LagBoundsMarket,
} from "@/lib/limits/earn-pricing";

const FX = JSON.parse(readFileSync(join(process.cwd(), "__tests__/fixtures/limits/rust-p3-final.json"), "utf8")) as {
  pricingClaimVectors: [string, string, string, string][];
  recoverVectors: [string, string, string, string, string, string][];
};

const epochs = { oracleEpoch: 9n, fundingEpoch: 9n, riskEpoch: 3n, assetSetEpoch: 1n };
const market = (eff: bigint, tgt: bigint): LagBoundsMarket => ({ ...epochs, priceOf: (a) => (a === 0 ? { eff, tgt } : null) });
const lp = (o: Partial<LagBoundsLp> = {}): LagBoundsLp => ({
  capital: 100_000_000n,
  pnl: 0n,
  feeCredits: 0n,
  activeBitmap: 1n,
  staleState: 0,
  bStaleState: 0,
  cert: { certifiedEquity: 120_000_000n, oracleEpoch: 9n, fundingEpoch: 9n, riskEpoch: 3n, assetSetEpoch: 1n, activeBitmapAtCert: 1n, validByte: 1 },
  legs: [{ slot: 0, assetIndex: 0, side: 1, basisPosQ: -400_000_000n }], // SHORT 400
  ...o,
});

describe("Rust parity: the pure rules 77 / 75 price through (rustc vectors)", () => {
  it("vault_lp_senior_pricing_claim", () => {
    expect(FX.pricingClaimVectors.length).toBeGreaterThan(5);
    for (const [c, d, s, want] of FX.pricingClaimVectors) expect(seniorPricingClaim(BigInt(c), BigInt(d), BigInt(s)).toString(), `${c},${d},${s}`).toBe(want);
  });
  it("vault_lp_recover (the 75 draw-outstanding term): to_seniors = min(value_above_c, outstanding)", () => {
    expect(FX.recoverVectors.length).toBeGreaterThan(4);
    for (const [c, , outst, above, to, cAfter] of FX.recoverVectors) {
      // liveDepositClaim(cEff, nav, outstanding, better) with nav + better - cEff == above
      const got = liveDepositClaim({ cEff: BigInt(c), nav: BigInt(c) + BigInt(above), outstanding: BigInt(outst), better: 0n });
      expect(got.toString(), `recover ${c}/${outst}/${above}`).toBe(BigInt(outst) === 0n ? c : cAfter);
      expect(BigInt(cAfter) - BigInt(c)).toBe(BigInt(to));
    }
  });
});

describe("vault_lp_equity_lag_bounds_ro", () => {
  it("risk_notional_ceil rounds up (against the user in both directions)", () => {
    expect(riskNotionalCeil(1n, 1n)).toBe(1n);
    expect(riskNotionalCeil(400_000_000n, 100_000n)).toBe(40_000_000n);
    expect(riskNotionalCeil(3n, 333_333n)).toBe(1n);
    expect(riskNotionalCeil(0n, 5n)).toBe(0n);
  });
  it("SHORT 400 with the target $0.10 above eff: adverse 40 USDC, favorable 0", () => {
    expect(vaultLpEquityLagBounds(lp(), market(1_000_000n, 1_100_000n))).toEqual({ worse: 80_000_000n, better: 120_000_000n });
  });
  it("the mirror: target below eff is favorable for a short, adverse for a long", () => {
    expect(vaultLpEquityLagBounds(lp(), market(1_000_000n, 900_000n))).toEqual({ worse: 120_000_000n, better: 160_000_000n });
    const long = lp({ legs: [{ slot: 0, assetIndex: 0, side: 0, basisPosQ: 400_000_000n }] });
    expect(vaultLpEquityLagBounds(long, market(1_000_000n, 900_000n))).toEqual({ worse: 80_000_000n, better: 120_000_000n });
  });
  it("q = |raw basis|; the ceil is per LEG (two legs of 1 unit at a 1-atom move = 2, not ceil(2e-6) = 1)", () => {
    const two = lp({
      activeBitmap: 3n,
      cert: { ...lp().cert, activeBitmapAtCert: 3n },
      legs: [
        { slot: 0, assetIndex: 0, side: 0, basisPosQ: 1n },
        { slot: 1, assetIndex: 0, side: 1, basisPosQ: -1n },
      ],
    });
    // long: adverse eff - tgt = 1; short: favorable eff - tgt = 1 — one atom each side, ceil'd per leg
    expect(vaultLpEquityLagBounds(two, market(1_000_001n, 1_000_000n))).toEqual({ worse: 120_000_000n - 1n, better: 120_000_000n + 1n });
    const both = lp({ activeBitmap: 3n, cert: { ...lp().cert, activeBitmapAtCert: 3n }, legs: [{ slot: 0, assetIndex: 0, side: 0, basisPosQ: 1n }, { slot: 1, assetIndex: 0, side: 0, basisPosQ: 1n }] });
    expect(vaultLpEquityLagBounds(both, market(1_000_001n, 1_000_000n))).toEqual({ worse: 120_000_000n - 2n, better: 120_000_000n });
  });
  it("no catch-up: both bounds = certified equity; a flat LP: both = conservative equity", () => {
    expect(vaultLpEquityLagBounds(lp(), market(1_000_000n, 1_000_000n))).toEqual({ worse: 120_000_000n, better: 120_000_000n });
    const flat = lp({ activeBitmap: 0n, legs: [], pnl: -7n, capital: 100n });
    expect(vaultLpEquityLagBounds(flat, market(1n, 999n))).toEqual({ worse: 93n, better: 93n });
  });
  it("CONTROL: a stale certificate with inventory is refused (85) — the app prices the post-crank state", () => {
    expect(vaultLpEquityLagBounds(lp({ staleState: 1 }), market(1n, 2n))).toBe("stale");
    expect(vaultLpEquityLagBounds(lp({ cert: { ...lp().cert, oracleEpoch: 8n } }), market(1n, 2n))).toBe("stale");
  });
});

describe("77 / 75 Live composition", () => {
  it("77: a move the junior absorbs changes nothing for seniors (worse >= 0)", () => {
    expect(liveRedeemSeniorValue({ c: 1_000n, nav: 1_000n, lpValue: 120n, worse: 80n })).toBe(1_000n);
  });
  it("77: worse < 0 => C_price = C - max(0, -worse - (nav - C)); senior = C_price when nav covers it", () => {
    expect(liveRedeemSeniorValue({ c: 1_000n, nav: 1_000n, lpValue: 0n, worse: -30n })).toBe(970n);
    expect(liveRedeemSeniorValue({ c: 1_000n, nav: 1_020n, lpValue: 0n, worse: -30n })).toBe(990n); // 20 of junior surplus in the pots
  });
  it("77: nav < C_price => the LP counts at min(value, max(worse, 0))", () => {
    expect(liveRedeemSeniorValue({ c: 1_000n, nav: 600n, lpValue: 500n, worse: 300n })).toBe(900n);
    expect(liveRedeemSeniorValue({ c: 1_000n, nav: 600n, lpValue: 200n, worse: 300n })).toBe(800n);
  });
  it("75: unchanged without a draw outstanding; with one, the pending recovery is priced in (capped)", () => {
    expect(liveDepositClaim({ cEff: 1_000n, nav: 900n, outstanding: 0n, better: 500n })).toBe(1_000n);
    expect(liveDepositClaim({ cEff: 1_000n, nav: 900n, outstanding: 100n, better: 150n })).toBe(1_050n);
    expect(liveDepositClaim({ cEff: 1_000n, nav: 900n, outstanding: 100n, better: 500n })).toBe(1_100n);
    expect(liveDepositClaim({ cEff: 1_000n, nav: 900n, outstanding: 100n, better: -5n })).toBe(1_000n);
  });
  it("earnSeniorPricing: stale => no numbers; resolved => unchanged", () => {
    expect(earnSeniorPricing({ resolved: false, cEff: 1n, nav: 1n, outstanding: 0n, lp: lp({ staleState: 1 }), market: market(1n, 2n) })).toEqual({ depositClaim: null, withdrawSeniorValue: null });
    expect(earnSeniorPricing({ resolved: true, cEff: 1n, nav: 1n, outstanding: 0n, lp: null, market: null, resolvedSenior: 7n })).toEqual({ depositClaim: null, withdrawSeniorValue: 7n });
  });
  it("earnSeniorPricing: a SHORT vault LP facing a pending +10% move; exit priced below C, entry unchanged", () => {
    // certified 20 USDC, short 400 => worse = 20 - 40 = -20 USDC; nav == C (pots hold the seniors only)
    const L = lp({ cert: { ...lp().cert, certifiedEquity: 20_000_000n } });
    const r = earnSeniorPricing({ resolved: false, cEff: 1_000_000_000n, nav: 1_000_000_000n, outstanding: 0n, lp: L, market: market(1_000_000n, 1_100_000n) });
    expect(r.withdrawSeniorValue).toBe(980_000_000n);
    expect(r.depositClaim).toBe(1_000_000_000n);
  });
});
