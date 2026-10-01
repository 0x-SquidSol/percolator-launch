/**
 * Two-pot Earn vault payout (live investigation 2026-10-01b, SI "Payout not sent"): 77 prices on
 * both pots, pays from one (Custom 25); a 100% exit fails the stay-fully-backed gate (Custom 21).
 * The fixture is SI's live state on 2026-10-01; every expected number below was checked by
 * simulating [91, 77] on a surfpool fork of devnet as the redeemer 9sM73A:
 *   capped 2,597,343,527 shares  -> OK paid 2,600,140,063 (exactly `atoms`)
 *   exact cap 2,599,943,471      -> OK paid 2,602,742,806
 *   full 2,599,991,798           -> Custom 21;  77 without 91 -> Custom 25
 */
import { describe, expect, it } from "vitest";
import * as C from "@/lib/limits/constants";
import {
  cappedShares,
  combinedVault,
  decodeDomainLedger,
  movablePrincipal,
  planSplitPotRedemption,
  syncedLedger,
  type DomainState,
} from "@/lib/limits/earn-split-pot";

const BS = C.BOUND_SCALE;
const ledger = (principal: bigint) => ({
  totalPrincipal: principal, totalEarnings: 0n, totalEarningsWithdrawn: 0n, lastObsBucketEarnings: 0n,
  cumulativeLoss: 0n, cumulativeRecovery: 0n, lastObsUnavailable: 0n,
});
const source = (freshReservedAtoms: bigint, pcbAtoms = 0n) => ({
  positiveClaimBound: pcbAtoms * BS, freshReserved: freshReservedAtoms * BS, validLienedBacking: 0n,
  insuranceCreditReserved: 0n, validLienedInsurance: 0n, impairedLienedInsurance: 0n,
});
const bucket = (freshAtoms: bigint, consumedAtoms = 0n) => ({
  freshUnliened: freshAtoms * BS, validLiened: 0n, consumed: consumedAtoms * BS, impaired: 0n, utilFeeEarnings: 0n, status: 1,
});

// SI, 2026-10-01 (domain 0 = the registry's pot, domain 1 = the sibling).
const SI_OWN: DomainState = { bucket: bucket(1_603_372_739n), source: source(1_603_372_739n, 596_957n), ledger: ledger(1_602_825_164n) };
const SI_SIB: DomainState = { bucket: bucket(1_000_000_002n, 32_976n), source: source(1_000_000_002n), ledger: ledger(1_000_000_000n) };
const TOTAL = 2_599_992_799n;
const HELD = 2_599_991_798n;
const plan = (shares: bigint, own = SI_OWN, sib = SI_SIB) => planSplitPotRedemption({ own, sib, totalShares: TOTAL, shares, feeShareBps: 1000 })!;

describe("split-pot Earn payout (SI live fixture, fork-verified)", () => {
  it("prices both pots like the program: the sibling's 32,976 consumed is net impairment", () => {
    expect(combinedVault(SI_OWN, SI_SIB, 1000)).toEqual({ nav: 2_602_792_188n, available: 2_602_792_188n });
    expect(movablePrincipal(SI_SIB)).toBe(999_967_024n);
  });

  it("moves the sibling pot in with 91 and refuses the full exit before signing", () => {
    const p = plan(HELD);
    expect(p.rebalance).toBe(999_967_024n);
    expect(p.payable).toBe(false);
    expect(p.maxShares).toBe(2_599_943_471n);
  });

  it("the capped re-request pays exactly what the fork paid", () => {
    const capped = cappedShares(plan(HELD).maxShares, HELD);
    expect(capped).toBe(2_597_343_527n);
    const p = plan(capped);
    expect(p.payable).toBe(true);
    expect(p.rebalance).toBe(999_967_024n);
    expect(p.atoms).toBe(2_600_140_063n);
  });

  it("the cap is tight: maxShares pays, one more share does not", () => {
    expect(plan(2_599_943_471n).payable).toBe(true);
    expect(plan(2_599_943_471n).atoms).toBe(2_602_742_806n);
    expect(plan(2_599_943_472n).payable).toBe(false);
  });

  it("needs no 91 when the payout pot alone covers the payout", () => {
    const p = plan(1_000_000_000n);
    expect(p.payable).toBe(true);
    expect(p.rebalance).toBe(0n);
  });

  it("a single-pot vault (empty sibling) never rebalances", () => {
    const own: DomainState = { bucket: bucket(2_000_000_000n), source: source(2_000_000_000n), ledger: ledger(2_000_000_000n) };
    const sib: DomainState = { bucket: { ...bucket(0n), status: 0 }, source: source(0n), ledger: null };
    const p = planSplitPotRedemption({ own, sib, totalShares: 2_000_000_000n, shares: 2_000_000_000n, feeShareBps: 1000 })!;
    expect(p.rebalance).toBe(0n);
    expect(p.payable).toBe(true);
  });

  it("a missing ledger is seeded from the bucket, as the program does", () => {
    const l = syncedLedger({ bucket: bucket(500n, 20n), source: source(500n), ledger: null });
    expect(l.totalPrincipal).toBe(520n);
    expect(l.cumulativeLoss).toBe(20n);
  });

  it("decodes the ledger layout read live (principal, earnings, loss/recovery, watermark)", () => {
    const d = new Uint8Array(80 + 16 * 9);
    const put = (i: number, v: bigint) => new DataView(d.buffer).setBigUint64(80 + i * 16, v, true);
    put(0, 1_602_825_164n); put(3, 7n); put(4, 2n); put(5, 7n); put(6, 30n); put(7, 10n); put(8, 20n);
    expect(decodeDomainLedger(d)).toEqual({
      totalPrincipal: 1_602_825_164n, totalEarnings: 7n, totalEarningsWithdrawn: 2n, lastObsBucketEarnings: 7n,
      cumulativeLoss: 30n, cumulativeRecovery: 10n, lastObsUnavailable: 20n,
    });
    expect(decodeDomainLedger(null)).toBeNull();
  });
});
