/**
 * P1 wrapper safety release: client ports of `risk_limits_v17` (percolator-prog
 * `feat/p1-safety-release@e74809b1`, `src/v16_program.rs` `mod risk_limits_v17`) plus the
 * processor's input gathering (`lp_floor_and_cap_q_view`,
 * `lp_trade_headroom_before_matcher`, `ensure_protocol_side_oi_cap_view`).
 *
 * Every function is integer-exact bigint and named after the Rust fn it
 * mirrors. `maxTradeSizePerSide` combines them with the matcher caps into the
 * order ticket's live "max long / max short".
 */
import {
  BPS,
  DEFAULT_EXEC_BAND_BPS,
  MAX_EXEC_BAND_BPS,
  MAX_LP_EXPOSURE_K_BPS,
  MAX_OI_SIDE_Q,
  POS_SCALE,
} from "./constants";
import { UNLIMITED_CAPACITY, remainingSideCapacityQ } from "@/lib/marketCapacity";
import { conservativeEquity, vaultLpCapQ } from "./vault-tranche";

export type Side = "long" | "short";

/** `effective_exec_band_bps`. */
export function effectiveExecBandBps(stored: number): number {
  if (stored === 0) return DEFAULT_EXEC_BAND_BPS;
  if (stored > MAX_EXEC_BAND_BPS) return MAX_EXEC_BAND_BPS;
  return stored;
}

/** `exec_price_within_band`: `|exec - ref| * 1e4 <= ref * band`; a zero ref is never in band. */
export function execPriceWithinBand(execE6: bigint, refE6: bigint, bandBps: number): boolean {
  if (refE6 === 0n) return false;
  const diff = execE6 > refE6 ? execE6 - refE6 : refE6 - execE6;
  return diff * BPS <= refE6 * BigInt(bandBps);
}

/** Band edges `[ref*(1-b), ref*(1+b)]`, floored/ceiled INWARD so every shown edge is in-band. */
export function bandEdgesE6(refE6: bigint, bandBps: number): { lo: bigint; hi: bigint } {
  const b = BigInt(bandBps);
  const lo = (refE6 * (BPS - b) + BPS - 1n) / BPS; // ceil
  const hi = (refE6 * (BPS + b)) / BPS; // floor
  return { lo: lo < 0n ? 0n : lo, hi };
}

/** `default_lp_exposure_k_bps`: `1e8 / imr_bps`, saturating at the setter max. */
export function defaultLpExposureKBps(initialMarginBps: bigint): number {
  if (initialMarginBps === 0n) return MAX_LP_EXPOSURE_K_BPS;
  const k = 100_000_000n / initialMarginBps;
  return k > BigInt(MAX_LP_EXPOSURE_K_BPS) ? MAX_LP_EXPOSURE_K_BPS : Number(k);
}

/** `effective_lp_exposure_k_bps`. */
export function effectiveLpExposureKBps(stored: number, initialMarginBps: bigint): number {
  if (stored === 0) return defaultLpExposureKBps(initialMarginBps);
  if (stored > MAX_LP_EXPOSURE_K_BPS) return MAX_LP_EXPOSURE_K_BPS;
  return stored;
}

/** `account_equity_init_raw`: `capital + min(pnl, 0) - |fee_credits|` (engine v16.rs:23774). */
export function lpEquityInitRaw(capital: bigint, pnl: bigint, feeCredits: bigint): bigint {
  const feeDebt = feeCredits < 0n ? -feeCredits : feeCredits;
  return capital + (pnl < 0n ? pnl : 0n) - feeDebt;
}

/** `nonneg_equity`. */
export const nonnegEquity = (e: bigint): bigint => (e <= 0n ? 0n : e);

const U128_MAX = (1n << 128n) - 1n;

/**
 * `lp_exposure_cap_q`: `floor(equity * k * POS_SCALE / (1e4 * price))`; zero
 * price => 0 (fail closed); a u128 overflow saturates to u128::MAX like Rust.
 */
export function lpExposureCapQ(equityAtoms: bigint, kBps: number, priceE6: bigint, posScale = POS_SCALE): bigint {
  if (priceE6 === 0n) return 0n;
  const num = equityAtoms * BigInt(kBps) * posScale;
  if (num > U128_MAX) return U128_MAX;
  return num / (BPS * priceE6);
}

/** `lp_risk_increasing`: |after| > |before|. */
export function lpRiskIncreasing(before: bigint, after: bigint): boolean {
  return abs(after) > abs(before);
}

/** `lp_fill_headroom_q`. `lpDeltaSign` is the sign of the LP's position change. */
export function lpFillHeadroomQ(beforeQ: bigint, lpDeltaSign: 1 | -1, capQ: bigint): bigint {
  const a = abs(beforeQ);
  const m = capQ > a ? capQ : a;
  const same = beforeQ === 0n || (beforeQ > 0n && lpDeltaSign > 0) || (beforeQ < 0n && lpDeltaSign < 0);
  if (same) return m - a;
  const s = m + a;
  return s > U128_MAX ? U128_MAX : s;
}

/** `lp_floor_halts`. */
export function lpFloorHalts(equityInit: bigint, floorAtoms: bigint, riskIncreasing: boolean): boolean {
  return riskIncreasing && nonnegEquity(equityInit) <= floorAtoms;
}

/** `effective_side_oi_cap_q`. */
export function effectiveSideOiCapQ(stored: bigint, engineMax = MAX_OI_SIDE_Q): bigint {
  return stored === 0n || stored > engineMax ? engineMax : stored;
}

/** `side_oi_growth_allowed`: a side may end above the cap only if it did not grow. */
export function sideOiGrowthAllowed(before: bigint, after: bigint, cap: bigint): boolean {
  return after <= cap || after <= before;
}

/** The taker's side moves the LP the opposite way (taker long => LP delta negative). */
export const lpDeltaSignFor = (side: Side): 1 | -1 => (side === "long" ? -1 : 1);

/**
 * `floored_lp_reducing_room_q` (P1 6066399f, P1-K1): a FLOORED LP's room is
 * `|before|` when the move reduces it (opposite sign), else 0 = halted.
 */
export function flooredLpReducingRoomQ(beforeQ: bigint, lpDeltaSign: 1 | -1): bigint {
  const reduces = (beforeQ > 0n && lpDeltaSign < 0) || (beforeQ < 0n && lpDeltaSign > 0);
  return reduces ? abs(beforeQ) : 0n;
}

/**
 * Port of `lp_trade_headroom_before_matcher` (P1 6066399f): the size the
 * wrapper hands the matcher in `side`. A floored LP only takes the reducing
 * part, clipped to flatten; with 0 room the wrapper REFUSES (LpFloorHalt, not
 * a zero fill), which is why the ticket disables that side.
 */
export function lpTradeHeadroomQ(
  lpPosQ: bigint,
  side: Side,
  capQ: bigint,
  floorBreached: boolean,
): bigint {
  const sign = lpDeltaSignFor(side);
  if (floorBreached) return flooredLpReducingRoomQ(lpPosQ, sign);
  return lpFillHeadroomQ(lpPosQ, sign, capQ);
}

/** Position contribution to a side's OI (basis; effective OI is A-scaled <= basis). */
const pos = (x: bigint): bigint => (x > 0n ? x : 0n);
const neg = (x: bigint): bigint => (x < 0n ? -x : 0n);

/**
 * Side-OI after a taker fill of signed `sizeQ` against the LP, both sides.
 * Only the two traded portfolios' legs change (the fill is bilateral).
 */
export function sideOiAfterFill(
  oiLong: bigint,
  oiShort: bigint,
  takerPosQ: bigint,
  lpPosQ: bigint,
  sizeQ: bigint,
): { long: bigint; short: bigint } {
  const t1 = takerPosQ + sizeQ;
  const l1 = lpPosQ - sizeQ;
  const long = oiLong - pos(takerPosQ) - pos(lpPosQ) + pos(t1) + pos(l1);
  const short = oiShort - neg(takerPosQ) - neg(lpPosQ) + neg(t1) + neg(l1);
  return { long: long < 0n ? 0n : long, short: short < 0n ? 0n : short };
}

/**
 * Largest |size| in `side` that `ensure_protocol_side_oi_cap_view` accepts.
 * The allowed set is a prefix in |size| (once a side exceeds both its cap and
 * its before-value it only grows), so a binary search is exact.
 */
export function sideOiHeadroomQ(
  oiLong: bigint,
  oiShort: bigint,
  takerPosQ: bigint,
  lpPosQ: bigint,
  side: Side,
  capQ: bigint,
  searchMaxQ: bigint = MAX_OI_SIDE_Q * 2n,
): bigint {
  const ok = (m: bigint): boolean => {
    const s = side === "long" ? m : -m;
    const a = sideOiAfterFill(oiLong, oiShort, takerPosQ, lpPosQ, s);
    return sideOiGrowthAllowed(oiLong, a.long, capQ) && sideOiGrowthAllowed(oiShort, a.short, capQ);
  };
  if (ok(searchMaxQ)) return searchMaxQ;
  let lo = 0n;
  let hi = searchMaxQ;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export type SizeLimitReason =
  | "lp-halt"
  | "lp-exposure"
  | "side-oi"
  | "matcher-fill"
  | "matcher-inventory"
  | "vault-lp-exposure"
  | "same-owner"
  | "none";

export interface SideLimit {
  /** Largest |size| (base q) that fills in full. UNLIMITED_CAPACITY = no binding limit. */
  maxQ: bigint;
  reason: SizeLimitReason;
  /** Opening in this side is halted (LP at its floor and this side grows LP risk). */
  halted: boolean;
}

export interface SizeLimitInputs {
  priceE6: bigint;
  initialMarginBps: bigint;
  oiEffLongQ: bigint;
  oiEffShortQ: bigint;
  limits: { sideOiCapQ: bigint; lpFloorAtoms: bigint; lpExposureKBps: number };
  /** LP portfolio; null = unknown (then the P1 LP rules are not applied). */
  lp: { posQ: bigint; capital: bigint; pnl: bigint; feeCredits: bigint } | null;
  /** The taker's own signed position on the asset (0 if none / unknown). */
  takerPosQ: bigint;
  /** Matcher caps; null = unknown. `maxFillAbs == 0` = no per-fill cap. */
  matcher: { maxFillAbs: bigint; maxInventoryAbs: bigint; inventoryBase: bigint | null } | null;
  /**
   * P3-H2: the LP IS the asset's bound vault LP => its protocol exposure cap
   * (`|pos|·mark <= conservative_equity · lev / 1e4`, default 1x) also applies.
   * Checked post-fill by the program (refusal Custom(80), not a clip).
   */
  vaultLp?: { levBps: number } | null;
}

export interface LpRiskState {
  equity: bigint;
  kBps: number;
  capQ: bigint;
  floorBreached: boolean;
}

/** `lp_floor_and_cap_q_view`. */
export function lpRiskState(i: SizeLimitInputs): LpRiskState | null {
  if (!i.lp) return null;
  const equity = lpEquityInitRaw(i.lp.capital, i.lp.pnl, i.lp.feeCredits);
  const kBps = effectiveLpExposureKBps(i.limits.lpExposureKBps, i.initialMarginBps);
  return {
    equity,
    kBps,
    capQ: lpExposureCapQ(nonnegEquity(equity), kBps, i.priceE6),
    floorBreached: lpFloorHalts(equity, i.limits.lpFloorAtoms, true),
  };
}

/**
 * The ticket's live max size per side: the tightest of P1 LP headroom, P1
 * side-OI headroom, the matcher's per-fill cap and its inventory headroom.
 * Ties resolve in the order listed (the most explainable reason first).
 */
export function maxTradeSizePerSide(i: SizeLimitInputs): Record<Side, SideLimit> {
  const risk = lpRiskState(i);
  const oiCap = effectiveSideOiCapQ(i.limits.sideOiCapQ);
  const one = (side: Side): SideLimit => {
    const cands: { q: bigint; r: SizeLimitReason }[] = [];
    let halted = false;
    if (risk && i.lp) {
      const h = lpTradeHeadroomQ(i.lp.posQ, side, risk.capQ, risk.floorBreached);
      // P1 e74809b1: a request that is reduce-only for the TAKER skips the LP halt and
      // headroom clip (up to |taker position|; a larger size would flip, so it is judged
      // normally). Allowed sizes = [0, |pos|] ∪ [0, h] => max(|pos|, h).
      const closeRoom = sameOwnerRoomQ(i.takerPosQ, side);
      const room = closeRoom > h ? closeRoom : h;
      if (risk.floorBreached) {
        halted = room === 0n;
        cands.push({ q: room, r: "lp-halt" });
      } else {
        cands.push({ q: room, r: "lp-exposure" });
      }
      cands.push({ q: sideOiHeadroomQ(i.oiEffLongQ, i.oiEffShortQ, i.takerPosQ, i.lp.posQ, side, oiCap), r: "side-oi" });
      if (i.vaultLp) {
        const eq = conservativeEquity(i.lp.capital, i.lp.pnl, i.lp.feeCredits) ?? 0n;
        const vcap = vaultLpCapQ(eq, i.vaultLp.levBps, i.priceE6);
        cands.push({ q: lpFillHeadroomQ(i.lp.posQ, lpDeltaSignFor(side), vcap), r: "vault-lp-exposure" });
      }
    }
    if (i.matcher) {
      if (i.matcher.maxFillAbs > 0n) cands.push({ q: i.matcher.maxFillAbs, r: "matcher-fill" });
      if (i.matcher.inventoryBase !== null) {
        const inv = remainingSideCapacityQ(i.matcher.inventoryBase, i.matcher.maxInventoryAbs, side);
        if (inv !== UNLIMITED_CAPACITY) cands.push({ q: inv, r: "matcher-inventory" });
      }
    }
    let best: SideLimit = { maxQ: UNLIMITED_CAPACITY, reason: "none", halted };
    for (const c of cands) if (c.q < best.maxQ) best = { maxQ: c.q, reason: c.r, halted };
    return best;
  };
  return { long: one("long"), short: one("short") };
}

/**
 * Clamp a requested |size| to the side's max. Returns the clamped size and
 * whether a clamp happened (the ticket must say so — never clamp silently).
 */
export function clampSizeQ(requestedQ: bigint, limit: SideLimit): { sizeQ: bigint; clamped: boolean } {
  if (requestedQ <= limit.maxQ) return { sizeQ: requestedQ, clamped: false };
  return { sizeQ: limit.maxQ, clamped: true };
}

/**
 * `position_change_reduce_only` (P1 2e7f87de): a change is reduce-only iff it ends flat,
 * or keeps the same side with no larger magnitude (no flip, no growth).
 */
export function positionChangeReduceOnly(beforeQ: bigint, afterQ: bigint): boolean {
  if (afterQ === 0n) return true;
  return beforeQ !== 0n && beforeQ > 0n === afterQ > 0n && abs(afterQ) <= abs(beforeQ);
}

export type LpGate = "allow" | "floor-halt" | "cap-exceeded";

/**
 * `lp_fill_gate` (P1 e74809b1), the post-fill LP rule on every route:
 * 1. reduce-only for the counterparty (the taker) => always allowed — exits are never
 *    trapped by the halt or the cap;
 * 2. a fill that does not grow the LP's magnitude => allowed;
 * 3. else a floored LP halts; an LP past its cap is refused.
 */
export function lpFillGate(
  counterpartyBeforeQ: bigint,
  counterpartyAfterQ: bigint,
  lpBeforeQ: bigint,
  lpAfterQ: bigint,
  capQ: bigint,
  floorBreached: boolean,
): LpGate {
  if (positionChangeReduceOnly(counterpartyBeforeQ, counterpartyAfterQ)) return "allow";
  if (!lpRiskIncreasing(lpBeforeQ, lpAfterQ)) return "allow";
  if (floorBreached) return "floor-halt";
  if (abs(lpAfterQ) > capQ) return "cap-exceeded";
  return "allow";
}

/** `floored_lp_move_allowed`: on the non-clipping routes a floored LP may not grow. */
export const flooredLpMoveAllowed = (beforeQ: bigint, afterQ: bigint): boolean => !lpRiskIncreasing(beforeQ, afterQ);

/**
 * Item 2 with the reduce-only exemption (P1 2e7f87de): a same-owner / creator taker may
 * only CLOSE. Largest |size| such a taker can send in `side`: |position| when the side
 * reduces it (clipped so it cannot flip), else 0.
 */
export function sameOwnerRoomQ(takerPosQ: bigint, side: Side): bigint {
  const reduces = (takerPosQ > 0n && side === "short") || (takerPosQ < 0n && side === "long");
  return reduces ? abs(takerPosQ) : 0n;
}

/** Same-owner rule (P1 item 2): taker owner == LP owner, or == a non-zero asset_admin. */
export function sameOwnerBlocked(
  takerOwner: Uint8Array | null,
  lpOwner: Uint8Array | null,
  assetAdmin: Uint8Array | null,
): boolean {
  if (!takerOwner) return false;
  const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, k) => x === b[k]);
  if (lpOwner && eq(takerOwner, lpOwner)) return true;
  if (assetAdmin && assetAdmin.some((x) => x !== 0) && eq(takerOwner, assetAdmin)) return true;
  return false;
}

/** OI utilisation vs the effective cap, bps (0..10000+). */
export function oiUtilisationBps(oiQ: bigint, capQ: bigint): number {
  if (capQ === 0n) return 0;
  return Number((oiQ * BPS) / capQ);
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}
