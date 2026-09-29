/**
 * P3 vault-owned LP: client ports of `percolator-prog feat/p3-vault-owned-lp@c7437518`
 * `src/vault_lp_v18.rs` (tranche waterfall, share pricing, junior admission,
 * skew funding, leverage step-down) plus display-only helpers (share price,
 * APY from real fee credits, liquidation drift under skew funding).
 *
 * P3 is BLOCKED in security review (P3-H1/H2) and will be renumbered; the
 * math below is the part the review confirmed ("Confirmed in code"). Every
 * `null` mirrors Rust `None` = fail closed.
 */
import { BPS, POS_SCALE, SLOTS_PER_HOUR } from "./constants";

const bpsFloor = (x: bigint, bps: number): bigint | null => {
  const b = BigInt(bps);
  if (b > BPS) return null;
  return (x / BPS) * b + ((x % BPS) * b) / BPS;
};
const bpsCeil = (x: bigint, bps: number): bigint | null => {
  const b = BigInt(bps);
  if (b > BPS) return null;
  const rem = (x % BPS) * b;
  return (x / BPS) * b + rem / BPS + (rem % BPS !== 0n ? 1n : 0n);
};
const U128_MAX = (1n << 128n) - 1n;
/** `mul_div_floor`: None on d == 0 or on a u128-overflowing product (fail closed, like Rust). */
const mulDivFloor = (a: bigint, b: bigint, d: bigint): bigint | null => {
  if (d === 0n) return null;
  const p = a * b;
  return p > U128_MAX ? null : p / d;
};

export interface TrancheSplit {
  senior: bigint;
  junior: bigint;
}

/** `tranche_split`: senior = min(V, C), junior = V − senior. */
export function trancheSplit(vaultValue: bigint, seniorClaim: bigint): TrancheSplit {
  const senior = vaultValue < seniorClaim ? vaultValue : seniorClaim;
  return { senior, junior: vaultValue - senior };
}

/** `vault_value`. */
export const vaultValue = (backingNav: bigint, harvestable: bigint, lpValue: bigint): bigint =>
  backingNav + harvestable + lpValue;

/** `effective_senior_claim`: C + floor(harvestable·s/1e4). */
export function effectiveSeniorClaim(seniorClaim: bigint, harvestable: bigint, seniorFeeShareBps: number): bigint | null {
  const f = bpsFloor(harvestable, seniorFeeShareBps);
  return f === null ? null : seniorClaim + f;
}

/** `senior_impaired`. */
export const seniorImpaired = (vaultValue: bigint, seniorClaimEff: bigint): boolean => vaultValue < seniorClaimEff;

/** `senior_shares_for_deposit` (genesis 1:1; zero senior with shares = refuse). */
export function seniorSharesForDeposit(amount: bigint, totalShares: bigint, seniorValue: bigint): bigint | null {
  if (totalShares === 0n) return amount;
  if (seniorValue === 0n) return null;
  return mulDivFloor(amount, totalShares, seniorValue);
}

/** `senior_atoms_for_redemption`: floor(shares·senior/S). */
export function seniorAtomsForRedemption(shares: bigint, totalShares: bigint, seniorValue: bigint): bigint | null {
  if (totalShares === 0n || shares > totalShares) return null;
  return mulDivFloor(shares, seniorValue, totalShares);
}

/** `junior_floor_atoms`: ceil(C·floor_bps/1e4). */
export const juniorFloorAtoms = (seniorClaim: bigint, floorBps: number): bigint | null => bpsCeil(seniorClaim, floorBps);

/** `junior_withdraw_allowed`. */
export function juniorWithdrawAllowed(
  vaultValue: bigint,
  seniorClaimEff: bigint,
  backingCover: bigint,
  amount: bigint,
  floorBps: number,
): boolean {
  if (backingCover < seniorClaimEff) return false;
  const split = trancheSplit(vaultValue, seniorClaimEff);
  const floor = juniorFloorAtoms(seniorClaimEff, floorBps);
  if (floor === null) return false;
  return amount + floor <= split.junior;
}

/** Largest junior withdrawal `juniorWithdrawAllowed` admits (0 when blocked). */
export function juniorWithdrawableAtoms(
  vaultValue: bigint,
  seniorClaimEff: bigint,
  backingCover: bigint,
  floorBps: number,
): bigint {
  if (backingCover < seniorClaimEff) return 0n;
  const split = trancheSplit(vaultValue, seniorClaimEff);
  const floor = juniorFloorAtoms(seniorClaimEff, floorBps);
  if (floor === null || split.junior <= floor) return 0n;
  return split.junior - floor;
}

/** `recall_limit`. */
export const recallLimit = (seniorClaimEff: bigint, backingCover: bigint): bigint =>
  seniorClaimEff > backingCover ? seniorClaimEff - backingCover : 0n;

/** Senior share price in e6 collateral per share: floor(senior·1e6/S); null with no shares. */
export function seniorSharePriceE6(seniorValue: bigint, totalShares: bigint): bigint | null {
  if (totalShares === 0n) return null;
  return (seniorValue * 1_000_000n) / totalShares;
}

/** First-loss cushion: junior / senior-claim, bps (null when there is no senior claim). */
export function firstLossCushionBps(junior: bigint, seniorClaim: bigint): number | null {
  if (seniorClaim === 0n) return null;
  const bps = (junior * BPS) / seniorClaim;
  return Number(bps > 1_000_000n ? 1_000_000n : bps);
}

/** `skew_funding_rate_e9`: positive => longs pay. A SHORT vault LP means traders are long. */
export function skewFundingRateE9(lpNetQ: bigint, oiSideQ: bigint, slopeE9: bigint, maxE9: bigint): bigint {
  if (slopeE9 === 0n || maxE9 === 0n || lpNetQ === 0n || oiSideQ === 0n) return 0n;
  const a = lpNetQ < 0n ? -lpNetQ : lpNetQ;
  const share = a > oiSideQ ? oiSideQ : a;
  const mag = (slopeE9 * share) / oiSideQ;
  const capped = mag > maxE9 ? maxE9 : mag;
  return lpNetQ < 0n ? capped : -capped;
}

/** `combine_funding_rate_e9`: premium + skew clamped to ±max. */
export function combineFundingRateE9(premiumE9: bigint, skewE9: bigint, maxAbsE9: bigint): bigint {
  const s = premiumE9 + skewE9;
  return s > maxAbsE9 ? maxAbsE9 : s < -maxAbsE9 ? -maxAbsE9 : s;
}

/** `step_imr_bps`: clamp(max(base, |lp_net|·1e4/cap), base, max). */
export function stepImrBps(lpNetAbsQ: bigint, capQ: bigint, baseImrBps: bigint, maxImrBps: number): bigint {
  const max = BigInt(maxImrBps);
  if (capQ === 0n || max <= baseImrBps) return baseImrBps;
  let crowd = (lpNetAbsQ * BPS) / capQ;
  if (crowd > BPS) crowd = BPS;
  if (crowd <= baseImrBps) return baseImrBps;
  if (crowd >= max) return max;
  return crowd;
}

/** `joins_crowd`: the fill grows the vault LP's |inventory|. */
export const joinsCrowd = (lpBeforeQ: bigint, lpAfterQ: bigint): boolean =>
  (lpAfterQ < 0n ? -lpAfterQ : lpAfterQ) > (lpBeforeQ < 0n ? -lpBeforeQ : lpBeforeQ);

/** `leverage_gate_ok`: equity >= ceil(notional·imr/1e4); imr > 100% fails closed. */
export function leverageGateOk(equityAtoms: bigint, notional: bigint, imrBps: bigint): boolean {
  if (imrBps > BPS) return false;
  const req = bpsCeil(notional, Number(imrBps));
  return req !== null && equityAtoms >= req;
}

/**
 * Max leverage a NEW position in `takerBuys` direction may use under the
 * step-down, as a whole-x integer for the slider (floor(1e4/imr)). The step
 * applies only when the fill joins the crowd (grows |vault LP net|) — a taker
 * buy moves the LP short. Uses a one-unit probe: the step IMR is evaluated at
 * the POST-fill LP inventory in the program; for the slider cap we use the
 * current inventory plus the requested size.
 */
export function stepDownMaxLeverage(
  lpNetQ: bigint,
  sizeQ: bigint,
  takerBuys: boolean,
  levCapQ: bigint,
  baseImrBps: bigint,
  levMaxImrBps: number,
): { maxLeverage: number; stepped: boolean; imrBps: bigint } {
  const after = takerBuys ? lpNetQ - sizeQ : lpNetQ + sizeQ;
  const base = baseImrBps === 0n ? 1n : baseImrBps;
  if (!joinsCrowd(lpNetQ, after)) {
    return { maxLeverage: Number(BPS / base), stepped: false, imrBps: baseImrBps };
  }
  const imr = stepImrBps(after < 0n ? -after : after, levCapQ, baseImrBps, levMaxImrBps);
  const i = imr === 0n ? 1n : imr;
  return { maxLeverage: Number(BPS / i), stepped: imr > baseImrBps, imrBps: imr };
}

/** Funding paid (+) or received (−) per hour by a position, collateral atoms. Positive rate => longs pay. */
export function fundingPerHourAtoms(positionQ: bigint, priceE6: bigint, rateE9PerSlot: bigint): bigint {
  const notional = ((positionQ < 0n ? -positionQ : positionQ) * priceE6) / POS_SCALE;
  const perSlot = (notional * rateE9PerSlot) / 1_000_000_000n;
  const perHour = perSlot * SLOTS_PER_HOUR;
  return positionQ >= 0n ? perHour : -perHour;
}

/**
 * Liquidation drift under constant funding: margin consumed over `hours`, and
 * the resulting move of the liquidation price (collateral atoms / |pos| in
 * price e6). `warn` when that consumption is >= `warnBps` of the margin above
 * maintenance (default 10%). Positions that RECEIVE funding never warn.
 */
export function projectLiqDrift(
  positionQ: bigint,
  priceE6: bigint,
  rateE9PerSlot: bigint,
  marginAboveMaintAtoms: bigint,
  hours = 24n,
  warnBps = 1_000n,
): { consumedAtoms: bigint; liqMoveE6: bigint; warn: boolean } {
  const perHour = fundingPerHourAtoms(positionQ, priceE6, rateE9PerSlot);
  if (perHour <= 0n || positionQ === 0n) return { consumedAtoms: 0n, liqMoveE6: 0n, warn: false };
  const consumed = perHour * hours;
  const absPos = positionQ < 0n ? -positionQ : positionQ;
  const liqMoveE6 = (consumed * POS_SCALE) / absPos;
  const warn = marginAboveMaintAtoms <= 0n ? true : consumed * BPS >= marginAboveMaintAtoms * warnBps;
  return { consumedAtoms: consumed, liqMoveE6, warn };
}

export interface FeeSnapshot {
  /** unix seconds */
  t: number;
  seniorFeeCreditedAtoms: bigint;
  seniorClaimAtoms: bigint;
}

export const MIN_APY_WINDOW_SECS = 24 * 3600;

/**
 * APY (bps) from REAL fee credits between two snapshots: annualised
 * Δsenior_fee_credited / average C. Null below 24 h of history, with no
 * principal, or if the counter went backwards (a re-seed).
 */
export function apyFromFeeSnapshots(a: FeeSnapshot, b: FeeSnapshot): number | null {
  const dt = b.t - a.t;
  if (dt < MIN_APY_WINDOW_SECS) return null;
  const dFee = b.seniorFeeCreditedAtoms - a.seniorFeeCreditedAtoms;
  if (dFee < 0n) return null;
  const avgC = (a.seniorClaimAtoms + b.seniorClaimAtoms) / 2n;
  if (avgC === 0n) return null;
  const yearSecs = 365n * 24n * 3600n;
  return Number((dFee * BPS * yearSecs) / (avgC * BigInt(dt)));
}

/**
 * Creator wizard projection from a junior tranche J: the LP exposure cap in
 * collateral notional (J·k/1e4, P1's cap with LP equity ≈ J), and the most
 * senior (Earn) capital the junior floor allows (J·1e4/floor_bps).
 */
export function projectCreatorCaps(
  juniorAtoms: bigint,
  kBps: number,
  juniorFloorBps: number,
): { maxLpNotionalAtoms: bigint; maxSeniorAtoms: bigint } {
  const floor = BigInt(juniorFloorBps === 0 ? 1 : juniorFloorBps);
  return {
    maxLpNotionalAtoms: (juniorAtoms * BigInt(kBps)) / BPS,
    maxSeniorAtoms: (juniorAtoms * BPS) / floor,
  };
}

export interface EarnTrancheInput {
  seniorClaimAtoms: bigint;
  juniorFloorBps: number;
  seniorFeeShareBps: number;
  /** Backing NAV of the vault's pots (the existing Earn vault total). */
  backingNavAtoms: bigint;
  /** Not-yet-cranked LP fee leg (0 when unknown). */
  harvestableAtoms: bigint;
  /** Vault LP value: max(0, capital + pnl − fee debt) — an ESTIMATE (the program uses the certified equity). */
  lpValueAtoms: bigint;
  totalShares: bigint;
  /** Shares the user is looking at withdrawing (0 = none typed). */
  withdrawShares: bigint;
}

export interface EarnTrancheView {
  vaultValue: bigint;
  seniorClaimEff: bigint;
  senior: bigint;
  junior: bigint;
  sharePriceE6: bigint | null;
  cushionBps: number | null;
  impaired: boolean;
  /** Backing alone does not cover the senior claim: part of the value sits in the LP. */
  illiquid: boolean;
  juniorFloorAtoms: bigint;
  withdrawAtoms: bigint | null;
  withdrawKind: "normal" | "impaired" | "illiquid";
}

/** Everything the Earn tranche card shows, from on-chain inputs. */
export function earnTrancheView(i: EarnTrancheInput): EarnTrancheView | null {
  const cEff = effectiveSeniorClaim(i.seniorClaimAtoms, i.harvestableAtoms, i.seniorFeeShareBps);
  if (cEff === null) return null;
  const v = vaultValue(i.backingNavAtoms, i.harvestableAtoms, i.lpValueAtoms);
  const split = trancheSplit(v, cEff);
  const impaired = seniorImpaired(v, cEff);
  const illiquid = i.backingNavAtoms + i.harvestableAtoms < cEff;
  const withdrawAtoms = i.withdrawShares > 0n ? seniorAtomsForRedemption(i.withdrawShares, i.totalShares, split.senior) : null;
  return {
    vaultValue: v,
    seniorClaimEff: cEff,
    senior: split.senior,
    junior: split.junior,
    sharePriceE6: seniorSharePriceE6(split.senior, i.totalShares),
    cushionBps: firstLossCushionBps(split.junior, cEff),
    impaired,
    illiquid,
    juniorFloorAtoms: juniorFloorAtoms(cEff, i.juniorFloorBps) ?? 0n,
    withdrawAtoms,
    withdrawKind: impaired ? "impaired" : illiquid ? "illiquid" : "normal",
  };
}

/**
 * Keep a rolling list of fee snapshots (one per `minGapSecs`, at most
 * `maxAgeSecs` old) and return the APY over the OLDEST snapshot that is at
 * least 24 h older than `now`. Pure: storage is the caller's.
 */
export function rollFeeSnapshots(
  prev: FeeSnapshot[],
  now: FeeSnapshot,
  minGapSecs = 3_600,
  maxAgeSecs = 8 * 86_400,
): { list: FeeSnapshot[]; apyBps: number | null } {
  const kept = prev.filter((s) => now.t - s.t <= maxAgeSecs && s.t <= now.t);
  const last = kept[kept.length - 1];
  const list = !last || now.t - last.t >= minGapSecs ? [...kept, now] : kept;
  const base = list.find((s) => now.t - s.t >= MIN_APY_WINDOW_SECS) ?? null;
  return { list, apyBps: base ? apyFromFeeSnapshots(base, now) : null };
}

/**
 * Port of P3 `vault_lp_skew_rate_e9_view`: 0 unless bound with a slope; the
 * OI denominator is `max(oi_eff_long_q, oi_eff_short_q)`.
 */
export function vaultSkewRateE9(
  v: { bound: boolean; skewSlopeE9: bigint; skewMaxE9: bigint; lpNetQ: bigint } | null,
  oiEffLongQ: bigint,
  oiEffShortQ: bigint,
): bigint {
  if (!v || !v.bound || v.skewSlopeE9 === 0n) return 0n;
  const oi = oiEffLongQ > oiEffShortQ ? oiEffLongQ : oiEffShortQ;
  return skewFundingRateE9(v.lpNetQ, oi, v.skewSlopeE9, v.skewMaxE9);
}
