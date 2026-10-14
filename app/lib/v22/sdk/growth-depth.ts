/*
 * LOCAL ADAPTER PORT, not original code: verbatim (types narrowed to what the app needs) from percolator-sdk
 * `feat/v22-sdk-growth` @ 9902b20, src/abi/growth-v19.ts, section "v2.2 G8 depth input, liquidity tiers, epoch-clamp predicate,
 * graduation ceiling". `nCapQWithDepth` is not ported (the app never computes capacity). Do not edit here; fix upstream in percolator-sdk.
 * TODO(repin): delete this file when @percolatorct/sdk >= the release carrying these exports ships and re-export from the package.
 */

type Num = bigint | number;
const GROWTH_BPS = 10_000n;
function big(name: string, v: Num): bigint {
  if (typeof v === "bigint") return v;
  if (!Number.isInteger(v)) throw new Error(`${name} must be an integer, got ${v}`);
  return BigInt(v);
}
function divCeil(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** G8: a depth reading older than this many slots counts as absent (tier 0). */
export const DEPTH_MAX_AGE_SLOTS = 150n;
/** `AssetGrowthV19.depthSource` values. 2 (on-chain pool) is reserved and not built: tiers 2-3 are unreachable. */
export const DEPTH_SOURCE = Object.freeze({ None: 0, Attested: 1, OnChainPool: 2 } as const);
/** Tier thresholds, USD e6 of +-2% depth (collateral 6 decimals): tier 1, 2, 3. */
export const DEPTH_TIER_THRESHOLDS_E6 = Object.freeze([25_000_000_000n, 100_000_000_000n, 500_000_000_000n] as const);
/** Highest tier a keeper-attested depth can reach (I-D3). */
export const DEPTH_ATTESTED_MAX_TIER = 1;
/** Engine `MAX_BAND_BPS`. */
export const BAND_MAX_BPS = 2_000n;
/** `RATCHET_STEP_X100` (1x per ratchet epoch / per doubling). */
export const GROWTH_RATCHET_STEP_X100 = 100;
/** `RATCHET_EPOCH_SLOTS`. */
export const GROWTH_RATCHET_EPOCH_SLOTS = 9_000n;

/** The growth-record fields the ceiling view reads (the SDK's decoded `AssetGrowthV19` carries these and more). */
export interface GrowthCeilingRecord {
  cLaunchAtoms: bigint;
  lLaunchX100: number;
  lTierX100: number;
  ceilX100: number;
  rGapBps: number;
  depthSource: number;
  depthE6: bigint;
  depthSlot: bigint;
  depthPrevE6: bigint;
}

export function effectiveDepthE6(depthE6: bigint, depthPrevE6: bigint, depthSlot: bigint, nowSlot: bigint): bigint {
  // Display tolerance (differs from the chain on purpose): the polled cluster slot can lag the push's slot by a few
  // slots, so a push "in the future" reads as age 0 here instead of absent. On chain it is absent (fail closed).
  const age = nowSlot > depthSlot ? nowSlot - depthSlot : 0n;
  if (age > DEPTH_MAX_AGE_SLOTS) return 0n;
  return depthE6 < depthPrevE6 ? depthE6 : depthPrevE6;
}

export function depthTier(effectiveDepth: bigint, depthSource: number): number {
  // Mirrors growth_v19::depth_tier: only keeper-attested depth earns a tier, capped at 1; any other source is 0.
  if (depthSource !== DEPTH_SOURCE.Attested) return 0;
  let t = 0;
  for (const th of DEPTH_TIER_THRESHOLDS_E6) if (effectiveDepth >= th) t++;
  return t > DEPTH_ATTESTED_MAX_TIER ? DEPTH_ATTESTED_MAX_TIER : t;
}

export function lDepthX100(tier: number, lLaunchX100: number): number {
  switch (tier) {
    case 1: return 500;
    case 2: return 1_000;
    case 3: return 2_000;
    default: return lLaunchX100;
  }
}

export function lambdaDepthBps(tier: number): number {
  return tier >= 3 ? 30_000 : tier === 2 ? 20_000 : 10_000;
}

export function kappaDepth(tier: number): number {
  return tier >= 3 ? 20_000 : tier >= 1 ? 10_000 : 5_000;
}

export function bandRGapBps(bandBps: Num): bigint | null {
  const d = big("bandBps", bandBps);
  if (d <= 0n || d > BAND_MAX_BPS) return null;
  const num = (GROWTH_BPS + d) * (GROWTH_BPS + d);
  const g = divCeil(num, GROWTH_BPS - d) - GROWTH_BPS;
  return g > 0xffffn ? null : g;
}

export function clampEnforced(bandBps: Num, rGapBps: Num): boolean {
  const b = big("bandBps", bandBps);
  if (b === 0n) return false;
  const g = bandRGapBps(b);
  return g !== null && g === big("rGapBps", rGapBps);
}

export function capitalDoublings(cM: bigint, cLaunch: bigint): number {
  if (cLaunch === 0n || cM < cLaunch) return 0;
  let steps = 0;
  let level = cLaunch;
  while (level * 2n <= cM && steps < 128) { level *= 2n; steps++; }
  return steps;
}

export interface GrowthTargetInput {
  lLaunchX100: number;
  lTierX100: number;
  cM: bigint;
  cLaunchAtoms: bigint;
  tier: number;
  bandBps: number;
  rGapBps: number;
  forceDown?: boolean;
}

export function growthTargetCeilingX100(i: GrowthTargetInput): number {
  const launch = Math.min(i.lLaunchX100, i.lTierX100);
  if (i.forceDown === true || !clampEnforced(i.bandBps, i.rGapBps) || i.tier < 1) return launch;
  const steps = capitalDoublings(i.cM, i.cLaunchAtoms);
  const byCapital = i.lLaunchX100 + steps * GROWTH_RATCHET_STEP_X100;
  const byDepth = Math.min(lDepthX100(i.tier, i.lLaunchX100), byCapital);
  return Math.min(i.lTierX100, Math.max(i.lLaunchX100, byDepth));
}

export interface SdkNextUnlock {
  kind: "depth" | "capital" | "none";
  thresholdUsd?: number;
  leverageX100?: number;
  alsoRequiresCapitalUsd?: number;
}

export interface GrowthCeilingView {
  tier: number;
  effectiveDepthE6: bigint;
  clampEnforced: boolean;
  graduationOn: boolean;
  targetX100: number;
  ceilingX100: number;
  nextUnlock: SdkNextUnlock;
}

export function growthCeilingView(g: GrowthCeilingRecord, bandBps: number, nowSlot: bigint, cM: bigint, forceDown: boolean): GrowthCeilingView {
  const eff = effectiveDepthE6(g.depthE6, g.depthPrevE6, g.depthSlot, nowSlot);
  const tier = depthTier(eff, g.depthSource);
  const enforced = clampEnforced(bandBps, g.rGapBps);
  const base: GrowthTargetInput = { lLaunchX100: g.lLaunchX100, lTierX100: g.lTierX100, cM, cLaunchAtoms: g.cLaunchAtoms, tier, bandBps, rGapBps: g.rGapBps, forceDown };
  const target = growthTargetCeilingX100(base);
  const launch = Math.min(g.lLaunchX100, g.lTierX100);
  const stored = g.ceilX100 === 0 ? launch : g.ceilX100;
  const ceiling = Math.min(stored, target);
  const graduationOn = enforced && tier >= 1;
  let nextUnlock: SdkNextUnlock = { kind: "none" };
  if (enforced && !forceDown) {
    const maxTier = DEPTH_ATTESTED_MAX_TIER; // only attested depth exists on chain
    if (tier < maxTier) {
      const t2 = growthTargetCeilingX100({ ...base, tier: tier + 1 });
      if (t2 > target) nextUnlock = { kind: "depth", thresholdUsd: Number((DEPTH_TIER_THRESHOLDS_E6[tier] as bigint) / 1_000_000n), leverageX100: t2 };
    }
    if (nextUnlock.kind === "none" && g.cLaunchAtoms > 0n) {
      const need = g.cLaunchAtoms << BigInt(capitalDoublings(cM, g.cLaunchAtoms) + 1);
      const t2 = growthTargetCeilingX100({ ...base, cM: need });
      if (t2 > target) nextUnlock = { kind: "capital", thresholdUsd: Number(need / 1_000_000n), leverageX100: t2 };
      else if (tier < maxTier) {
        const both = growthTargetCeilingX100({ ...base, cM: need, tier: tier + 1 });
        if (both > target) nextUnlock = { kind: "depth", thresholdUsd: Number((DEPTH_TIER_THRESHOLDS_E6[tier] as bigint) / 1_000_000n), leverageX100: both, alsoRequiresCapitalUsd: Number(need / 1_000_000n) };
      }
    }
  }
  return { tier, effectiveDepthE6: eff, clampEnforced: enforced, graduationOn, targetX100: target, ceilingX100: ceiling, nextUnlock };
}
