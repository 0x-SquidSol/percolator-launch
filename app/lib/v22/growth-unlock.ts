/**
 * Graduation, liquidity tier and "what unlocks next" for a growth market (pure, never throws).
 *
 * Spec: ledger v22-growth-overnight-2026-10-14.md section 1. The math is the SDK's (percolator-sdk `feat/v22-sdk-growth`
 * @ 9902b20), copied in lib/v22/sdk/growth-depth.ts (TODO(repin) there). This module is the thin adapter: it reads the
 * depth bytes, calls `growthCeilingView`, adds the ratchet-in-progress case the SDK does not model (it needs the stored
 * `ceil_slot`), and turns the result into one calm line.
 *
 * What the user sees (and does not): a tier 0..3 badge, one "what unlocks next" line, and only on a market whose leverage
 * ceiling can graduate (a band market with the clamp enforced). Never a raw bps / x100 number. An off-band market has a
 * fixed ceiling (the creator's launch leverage), so it gets no unlock line and no tier.
 */
import { conservativeEquity } from "../v21/sdk";
import type { GrowthMarketView } from "../v21/growth-market";
import { V22_COPY } from "./copy";
import { resolveMarketGeometry } from "./sdk";
import { assetGrowthAccountOffsetV19 } from "./records";
import {
  DEPTH_MAX_AGE_SLOTS,
  DEPTH_TIER_THRESHOLDS_E6,
  GROWTH_RATCHET_EPOCH_SLOTS,
  GROWTH_RATCHET_STEP_X100,
  growthCeilingView,
  type GrowthCeilingRecord,
} from "./sdk/growth-depth";

export { DEPTH_MAX_AGE_SLOTS, DEPTH_TIER_THRESHOLDS_E6 };
export { bandRGapBps, capitalDoublings, clampEnforced, depthTier, effectiveDepthE6, growthTargetCeilingX100 } from "./sdk/growth-depth";

/** Slot time, only to say "about an hour" (400 ms). */
const SLOT_MS = 400n;

export type DepthTier = 0 | 1 | 2 | 3;

export interface GrowthDepth {
  /** 0 none, 1 keeper-attested, 2 on-chain pool (reserved). */
  source: number;
  depthE6: bigint;
  depthSlot: bigint;
  prevE6: bigint;
}

const DEPTH_OFF = { source: 44, depthE6: 56, depthSlot: 64, prevE6: 72 } as const;
const GROWTH_RECORD_LEN = 120;

/** The depth fields of a 120-byte `AssetGrowthV19` record; null when the bytes are not a record. */
export function readGrowthDepth(record: Uint8Array | null | undefined): GrowthDepth | null {
  if (!record || record.length !== GROWTH_RECORD_LEN) return null;
  const v = new DataView(record.buffer, record.byteOffset, record.byteLength);
  return {
    source: record[DEPTH_OFF.source] as number,
    depthE6: v.getBigUint64(DEPTH_OFF.depthE6, true),
    depthSlot: v.getBigUint64(DEPTH_OFF.depthSlot, true),
    prevE6: v.getBigUint64(DEPTH_OFF.prevE6, true),
  };
}

export type NextUnlock =
  | { kind: "ratchet"; leverageX100: number; slotsLeft: bigint }
  /** `moreCapitalUsd` set: the step also needs that much more market backing (one line says both). */
  | { kind: "depth"; leverageX100: number; depthUsd: number; moreCapitalUsd?: number }
  | { kind: "capital"; leverageX100: number; capitalUsd: number };

export interface GrowthUnlockView {
  /** The leverage ceiling can graduate on this market (band market, clamp enforced). */
  graduation: boolean;
  /** Null while the clock is unknown, or when graduation is off (no tier is shown there). */
  tier: DepthTier | null;
  unlock: NextUnlock | null;
}

export const NO_UNLOCK: GrowthUnlockView = { graduation: false, tier: null, unlock: null };

export interface GrowthUnlockInput {
  view: GrowthMarketView;
  /** Engine `band_bps` of the asset (0 = not a band market). */
  bandBps: number;
  /** The 120-byte growth record (for the depth fields). */
  record: Uint8Array | null | undefined;
  /** Cluster slot; null while unknown (then no tier or unlock is claimed). */
  nowSlot: bigint | null;
}

/** The 120 growth-record bytes of asset `assetIndex` in a raw market account; null for anything unreadable. */
export function growthRecordBytes(raw: Uint8Array | null | undefined, assetIndex = 0): Uint8Array | null {
  if (!raw) return null;
  try {
    const g = resolveMarketGeometry(raw, { parser: "growthRecordBytes", strictLength: false });
    const off = assetGrowthAccountOffsetV19(assetIndex, g.layout);
    return raw.length >= off + GROWTH_RECORD_LEN ? raw.subarray(off, off + GROWTH_RECORD_LEN) : null;
  } catch {
    return null;
  }
}

function ratchetSlotsLeft(ceilSlot: bigint, nowSlot: bigint): bigint {
  const at = ceilSlot + GROWTH_RATCHET_EPOCH_SLOTS;
  return nowSlot >= at ? 0n : at - nowSlot;
}

export function growthUnlockView(i: GrowthUnlockInput): GrowthUnlockView {
  const g = i.view.record;
  const depth = readGrowthDepth(i.record);
  const rec: GrowthCeilingRecord = {
    cLaunchAtoms: g.cLaunchAtoms,
    lLaunchX100: g.lLaunchX100,
    lTierX100: g.lTierX100,
    ceilX100: g.ceilX100,
    rGapBps: g.rGapBps,
    depthSource: depth?.source ?? 0,
    depthE6: depth?.depthE6 ?? 0n,
    depthSlot: depth?.depthSlot ?? 0n,
    depthPrevE6: depth?.prevE6 ?? 0n,
  };
  // Off-band (or r_gap not the derived one): nothing is said. Decided before the clock so it never flickers.
  const quick = growthCeilingView(rec, i.bandBps, 0n, 0n, true);
  if (!quick.clampEnforced) return NO_UNLOCK;
  if (i.nowSlot === null) return { graduation: true, tier: null, unlock: null };

  const q = i.view.quoteInput;
  const cM = conservativeEquity(q.lpCapital, q.lpPnl, q.lpFeeCredits);
  const cv = growthCeilingView(rec, i.bandBps, i.nowSlot, cM, i.view.hlockActive);
  const tier = cv.tier as DepthTier;
  const base: GrowthUnlockView = { graduation: true, tier, unlock: null };
  if (i.view.hlockActive) return base;

  // The ratchet is still walking up to a target already earned.
  if (cv.ceilingX100 < cv.targetX100) {
    const next = Math.min(cv.ceilingX100 + GROWTH_RATCHET_STEP_X100, cv.targetX100);
    return { ...base, unlock: { kind: "ratchet", leverageX100: next, slotsLeft: ratchetSlotsLeft(g.ceilSlot, i.nowSlot) } };
  }
  const u = cv.nextUnlock;
  if (u.kind === "depth" && u.thresholdUsd !== undefined && u.leverageX100 !== undefined) {
    const more = u.alsoRequiresCapitalUsd === undefined ? undefined : Math.max(0, u.alsoRequiresCapitalUsd - Number(cM / 1_000_000n));
    return { ...base, unlock: { kind: "depth", leverageX100: u.leverageX100, depthUsd: u.thresholdUsd, ...(more ? { moreCapitalUsd: more } : {}) } };
  }
  if (u.kind === "capital" && u.thresholdUsd !== undefined && u.leverageX100 !== undefined) {
    return { ...base, unlock: { kind: "capital", leverageX100: u.leverageX100, capitalUsd: u.thresholdUsd } };
  }
  return base;
}

// -- copy -------------------------------------------------------------------------------------------------------

const xLabel = (x100: number): string => `${x100 % 100 === 0 ? x100 / 100 : (x100 / 100).toFixed(1)}x`;

/** "$25k", "$1.5M": whole thousands read as k. */
export function compactUsd(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd % 1_000_000 === 0 ? 0 : 1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(usd % 1_000 === 0 ? 0 : 1)}k`;
  return `$${Math.round(usd)}`;
}

/** "about 20 minutes", "about an hour". */
export function waitLabel(slots: bigint): string {
  const minutes = Number((slots * SLOT_MS + 59_999n) / 60_000n);
  if (minutes >= 55) return "about an hour";
  return minutes <= 1 ? "about a minute" : `about ${minutes} minutes`;
}

/** The single calm line for the next unlock, or null. */
export function unlockLine(u: NextUnlock | null): string | null {
  if (!u) return null;
  switch (u.kind) {
    case "ratchet":
      return u.slotsLeft === 0n
        ? V22_COPY.growth.nextStepNow(xLabel(u.leverageX100))
        : V22_COPY.growth.nextStepAfter(xLabel(u.leverageX100), waitLabel(u.slotsLeft));
    case "depth":
      return u.moreCapitalUsd
        ? V22_COPY.growth.unlockDepthAndCapital(xLabel(u.leverageX100), compactUsd(u.depthUsd), compactUsd(u.moreCapitalUsd))
        : V22_COPY.growth.unlockDepth(xLabel(u.leverageX100), compactUsd(u.depthUsd));
    case "capital":
      return V22_COPY.growth.unlockCapital(xLabel(u.leverageX100), compactUsd(u.capitalUsd));
  }
}
