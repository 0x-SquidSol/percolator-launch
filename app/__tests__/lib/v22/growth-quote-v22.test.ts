import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { growthMarketView, type GrowthMarketInput } from "@/lib/v21/growth-market";
import { ASSET_GROWTH_FIELD_OFF, nCapQ } from "@/lib/v21/sdk";
import { LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC } from "@/lib/v22/sdk";
import { assetGrowthAccountOffsetV19 } from "@/lib/v22/records";

/**
 * Upgrade simulation 2026-10-14, finding 4 (CHILLHOUSE): with $400 of attested depth the program's N_cap is the kappa cap,
 * $200, not the growth-1 $1,013. The ticket must quote against the same numbers.
 */
const PRICE = 11_489_000n; // $11.489
const USD = 1_000_000n;
const NOW = 5_000_000n;

function market(depth: { source: number; usd: bigint; prevUsd: bigint; slot: bigint } | null): Uint8Array {
  const off = assetGrowthAccountOffsetV19(0, LAYOUT_V22);
  const raw = new Uint8Array(off + 400);
  const v = new DataView(raw.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, LAYOUT_V22.version, true);
  raw[10] = 1;
  const F = ASSET_GROWTH_FIELD_OFF;
  v.setBigUint64(off + F.cLaunchAtoms, 1_000n * USD, true);
  v.setUint32(off + F.lambdaBps, 10_000, true);
  v.setUint16(off + F.lLaunchX100, 500, true);
  v.setUint16(off + F.lTierX100, 500, true);
  v.setUint16(off + F.ceilX100, 500, true);
  v.setUint16(off + F.kinkBps, 5_000, true);
  v.setUint16(off + F.rGapBps, 500, true);
  raw[off + F.version] = 1;
  if (depth) {
    raw[off + 44] = depth.source;
    v.setBigUint64(off + 56, depth.usd * USD, true);
    v.setBigUint64(off + 64, depth.slot, true);
    v.setBigUint64(off + 72, depth.prevUsd * USD, true);
  }
  return raw;
}

const base = (raw: Uint8Array, oiLong: bigint): GrowthMarketInput => ({
  raw,
  engine: { initialMarginBps: 2_000n, effectivePriceE6: PRICE, oiEffLongQ: oiLong, oiEffShortQ: 0n, tradeFeeBaseBps: 30n, maxTradingFeeBps: 630n },
  lp: { capital: 1_013n * USD, pnl: 0n, feeCredits: 0n },
  lpEffectiveQ: 0n,
  bound: true,
});

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

describe("ticket quote follows the program's depth rules (simulation finding 4)", () => {
  // Built per test: the v2.2 offsets are flag-aware, so the flag must be on when the bytes are laid out.
  let raw: Uint8Array;
  beforeEach(() => {
    raw = market({ source: 1, usd: 400n, prevUsd: 400n, slot: NOW - 10n });
  });
  // 56.6% of the kappa-capped N_cap, which is 11% of the growth-1 N_cap.
  const OI = 9_860_000n;

  it("$400 attested depth: capacity is the kappa cap ($200), the crowd side steps down to about 3.27x", () => {
    const v = growthMarketView({ ...base(raw, OI), v22: { bandBps: 0, nowSlot: NOW } })!;
    expect(v.long.tier).toBe(0);
    const nCap = v.long.nCapQ!;
    expect(Number(nCap) / 1e6).toBeCloseTo(17.4, 0); // 17.4M Q
    expect((Number(nCap) * Number(PRICE)) / 1e12).toBeCloseTo(200, 0); // $200
    expect(v.long.maxLeverageX100).toBeGreaterThanOrEqual(325);
    expect(v.long.maxLeverageX100).toBeLessThanOrEqual(330);
  });

  it("the old (growth-1) quote on the same market would have said 5x and $1,013", () => {
    const old = growthMarketView(base(raw, OI))!; // no v22 input: what the app did before
    expect(old.long.maxLeverageX100).toBe(500);
    expect((Number(old.long.nCapQ!) * Number(PRICE)) / 1e12).toBeCloseTo(1_013, -1);
    expect(old.long.nCapQ).toBe(nCapQ(1_013n * USD, 10_000, PRICE, 1_000_000n));
  });

  it("clock unknown: tier 0, ceiling capped at launch, and the stored depth still caps room at 0.5 x depth ($200)", () => {
    const v = growthMarketView({ ...base(raw, OI), v22: { bandBps: 0, nowSlot: null } })!;
    expect(v.long.tier).toBe(0);
    expect(v.long.ceilingX100).toBeLessThanOrEqual(500);
    expect(v.long.nCapQ).toBe(growthMarketView({ ...base(raw, OI), v22: { bandBps: 0, nowSlot: NOW } })!.long.nCapQ);
    expect((Number(v.long.nCapQ!) * Number(PRICE)) / 1e12).toBeCloseTo(200, 0);
  });

  it("property: with the clock unknown, no side, ceiling or room is ever above ANY slot-known reading", () => {
    const vectors = [
      { depth: { source: 1, usd: 400n, prevUsd: 400n }, band: 0 },
      { depth: { source: 1, usd: 30_000n, prevUsd: 30_000n }, band: 0 }, // tier 1: kappa 1.0 when known
      { depth: { source: 1, usd: 30_000n, prevUsd: 30_000n }, band: 130 }, // band market, graduation possible
      { depth: { source: 1, usd: 30_000n, prevUsd: 0n }, band: 0 }, // prev 0 = absent when known
      { depth: { source: 2, usd: 900n, prevUsd: 900n }, band: 0 }, // non-attested source
      { depth: null, band: 0 },
    ];
    for (const vec of vectors) {
      const unknown = growthMarketView({ ...base(market(vec.depth ? { ...vec.depth, slot: NOW - 10n } : null), OI), v22: { bandBps: vec.band, nowSlot: null } })!;
      for (const nowSlot of [NOW, NOW - 12n, NOW + 5n, NOW + 100_000n]) {
        const known = growthMarketView({ ...base(market(vec.depth ? { ...vec.depth, slot: NOW - 10n } : null), OI), v22: { bandBps: vec.band, nowSlot } })!;
        for (const side of ["long", "short"] as const) {
          const u = unknown[side];
          const k = known[side];
          expect(u.ceilingX100).toBeLessThanOrEqual(k.ceilingX100);
          expect(u.nCapQ ?? 0n).toBeLessThanOrEqual(k.nCapQ ?? 0n);
          expect(u.headroomQ ?? 0n).toBeLessThanOrEqual(k.headroomQ ?? 0n);
          expect(u.closed ? 0 : u.maxLeverageX100).toBeLessThanOrEqual(k.closed ? 0 : k.maxLeverageX100 || 0);
        }
      }
    }
  });

  it("stale depth (over 150 slots old) is absent: no kappa cap, tier 0", () => {
    const stale = market({ source: 1, usd: 400n, prevUsd: 400n, slot: NOW - 151n });
    const v = growthMarketView({ ...base(stale, OI), v22: { bandBps: 0, nowSlot: NOW } })!;
    expect(v.long.nCapQ).toBe(nCapQ(1_013n * USD, 10_000, PRICE, 1_000_000n));
  });

  it("no depth at all, flag-on quote: same as growth-1 capacity", () => {
    const v = growthMarketView({ ...base(market(null), OI), v22: { bandBps: 0, nowSlot: NOW } })!;
    expect(v.long.maxLeverageX100).toBe(500);
  });
});
