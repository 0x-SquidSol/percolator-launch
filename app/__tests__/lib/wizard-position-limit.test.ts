/**
 * Create-wizard position limit (2026-10-01).
 *
 * Incident: market SI (8WC8vALs…) was seeded with 1,000 USDC of LP capital; one wallet
 * opened a ~$1,470 short against it (~1.5x the whole LP), SI fell ~40%, and the LP lost all
 * 1,000 and was closed out. The old wizard sized the matcher's max_inventory_abs at 40% of
 * LP x leverage, i.e. 4x the LP's capital at 10x — the position was well inside it.
 *
 * The LP's loss on a move is `exposure x move`, independent of the traders' leverage, so
 * the cap is now a multiple of the LP seed: 1x by default (a 40% adverse move on a full cap
 * costs 40% of the seed), creator-adjustable within [0.25x, 2x], with the calm wizard note
 * above 1.25x (40% x 1.25 = 50% of the seed).
 *
 * Wire layout of wrapper tag 83 (InitMatcherCtx) verified against the deployed wrapper
 * 553d76f0 src/v16_program.rs decode (tag 83): kind u8 @1, trading_fee u32 @2, base_spread
 * u32 @6, max_total u32 @10, impact_k u32 @14, liquidity_notional u128 @18, max_fill_abs
 * u128 @34, max_inventory_abs u128 @50, fee_to_insurance u16 @66, skew u16 @68.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeInitMatcherCtx } from "@percolatorct/sdk";
import {
  LP_EXPOSURE_DEFAULT_BPS,
  LP_EXPOSURE_MAX_BPS,
  LP_EXPOSURE_MIN_BPS,
  LP_EXPOSURE_SAFE_BPS,
  LP_SAFETY_MOVE_PCT,
  buildInitMatcherCtxArgs,
  clampLpExposureBps,
  deriveMatcherLimits,
  lpExposureAtoms,
} from "@/lib/matcher-params";
import { deriveLaunchMarketParams, deriveMarketParams } from "@/lib/market-params";

const USDC = 1_000_000n; // 6-decimal collateral atoms per unit
const LP_1000 = 1_000n * USDC;

/** Notional (collateral atoms) of a base-unit q at a price — the matcher-params inverse. */
const notionalAtoms = (q: bigint, priceE6: bigint) => (q * priceE6) / 1_000_000n;

function decodeCaps(data: Uint8Array) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const r128 = (o: number) => (dv.getBigUint64(o + 8, true) << 64n) | dv.getBigUint64(o, true);
  return { tag: data[0], maxFill: r128(34), maxInv: r128(50) };
}

describe("default position limit: a multiple of the LP seed, not of leverage", () => {
  it("is 1x the LP seed at the launch price, for every leverage", () => {
    const px = 500_000n; // $0.50
    for (const lev of [2, 3.5, 5, 10]) {
      const m = deriveMatcherLimits(lev, LP_1000, px);
      expect(notionalAtoms(m.maxInventoryAbs, px)).toBe(LP_1000);
    }
  });

  it("keeps a 40% adverse move on a full cap to at most half the LP (target), 40% at the default", () => {
    for (const px of [1_000n, 500_000n, 150_000_000n]) {
      const m = deriveMatcherLimits(10, LP_1000, px);
      const worstLoss = (notionalAtoms(m.maxInventoryAbs, px) * BigInt(LP_SAFETY_MOVE_PCT)) / 100n;
      expect(worstLoss).toBeLessThanOrEqual(LP_1000 / 2n);
      expect(worstLoss).toBeLessThanOrEqual((LP_1000 * 40n) / 100n);
    }
    // And at the edge of "safe" (1.25x) it is exactly half.
    const edge = deriveMatcherLimits(10, LP_1000, 1_000_000n, LP_EXPOSURE_SAFE_BPS);
    expect((notionalAtoms(edge.maxInventoryAbs, 1_000_000n) * 40n) / 100n).toBe(LP_1000 / 2n);
  });

  it("SI repro: a $1,470 one-sided position on a 1,000 LP no longer fits (it did under the old 4x cap)", () => {
    const px = 1_000_000n;
    const si = 1_470n * USDC;
    const m = deriveMatcherLimits(10, LP_1000, px);
    expect(notionalAtoms(m.maxInventoryAbs, px)).toBeLessThan(si);
    // The pre-fix formula (40% x LP x leverage), kept here as the control:
    const oldCap = (LP_1000 * 10n * 40n) / 100n;
    expect(oldCap).toBeGreaterThan(si);
  });

  it("scales with the seed the creator enters", () => {
    for (const lp of [100n, 500n, 5_000n, 10_000n]) {
      const m = deriveMatcherLimits(5, lp * USDC, 1_000_000n);
      expect(m.maxInventoryAbs).toBe(lp * USDC);
    }
  });

  it("one trade is at most a quarter of the cap", () => {
    const m = deriveMatcherLimits(10, LP_1000, 1_000_000n);
    expect(m.maxFillAbs).toBe(m.maxInventoryAbs / 4n);
    expect(m.maxFillAbs).toBe(250n * USDC);
  });
});

describe("clampLpExposureBps: the creator's override stays within safe bounds", () => {
  it("defaults anything missing or non-finite to 1x", () => {
    for (const v of [undefined, null, NaN, Infinity, -Infinity]) {
      expect(clampLpExposureBps(v as number)).toBe(LP_EXPOSURE_DEFAULT_BPS);
    }
    expect(LP_EXPOSURE_DEFAULT_BPS).toBe(10_000);
  });

  it("clamps to [0.25x, 2x]", () => {
    expect(clampLpExposureBps(0)).toBe(LP_EXPOSURE_MIN_BPS);
    expect(clampLpExposureBps(-5)).toBe(LP_EXPOSURE_MIN_BPS);
    expect(clampLpExposureBps(1_000_000)).toBe(LP_EXPOSURE_MAX_BPS);
    expect(clampLpExposureBps(15_000)).toBe(15_000);
    expect(LP_EXPOSURE_MAX_BPS).toBe(20_000);
  });

  it("lpExposureAtoms never goes above 2x the seed, whatever is passed", () => {
    expect(lpExposureAtoms(LP_1000, 999_999)).toBe(2n * LP_1000);
    expect(lpExposureAtoms(-5n, 10_000)).toBe(0n);
  });
});

describe("the wizard's launch params reach the encoded InitMatcherCtx", () => {
  const base = { initialMarginBps: 1_000, lpCollateral: LP_1000, initialPriceE6: 1_000_000n };

  it("default launch (no override) encodes max_inventory_abs = 1x the seed", () => {
    const d = deriveLaunchMarketParams(base);
    const data = encodeInitMatcherCtx(buildInitMatcherCtxArgs(10, d.matcher));
    const caps = decodeCaps(data);
    expect(caps.tag).toBe(83);
    expect(data.length).toBe(70);
    expect(caps.maxInv).toBe(LP_1000);
    expect(caps.maxFill).toBe(LP_1000 / 4n);
  });

  it("a creator override (1.5x) is what the instruction carries", () => {
    const d = deriveLaunchMarketParams({ ...base, lpExposureBps: 15_000 });
    const caps = decodeCaps(encodeInitMatcherCtx(buildInitMatcherCtxArgs(10, d.matcher)));
    expect(caps.maxInv).toBe((LP_1000 * 3n) / 2n);
    expect(caps.maxFill).toBe((LP_1000 * 3n) / 8n);
  });

  it("an out-of-bounds override is clamped before encoding", () => {
    const d = deriveLaunchMarketParams({ ...base, lpExposureBps: 90_000 });
    expect(decodeCaps(encodeInitMatcherCtx(buildInitMatcherCtxArgs(10, d.matcher))).maxInv).toBe(2n * LP_1000);
  });

  it("matches deriveMarketParams for the same inputs (one derivation)", () => {
    expect(deriveLaunchMarketParams(base).matcher).toEqual(deriveMarketParams(10, LP_1000, 1_000_000n).matcher);
  });
});

describe("wiring: every legacy create path derives from the launch params", () => {
  const root = join(__dirname, "../..");
  it("useCreateMarket uses deriveLaunchMarketParams(params) on both the merged and sequential paths", () => {
    const src = readFileSync(join(root, "hooks/useCreateMarket.ts"), "utf8");
    expect(src.match(/deriveLaunchMarketParams\(params\)/g)?.length).toBe(2);
    expect(src).not.toMatch(/deriveMarketParams\([^)]*params\.lpCollateral/);
  });

  it("the wizard sends its position limit on launch and on retry", () => {
    const src = readFileSync(join(root, "components/create/CreateMarketWizard.tsx"), "utf8");
    expect(src.match(/lpExposureBps: clampLpExposureBps\(wizard\.lpExposureBps\)/g)?.length).toBe(2);
  });
});
