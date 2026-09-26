/**
 * The creator dashboard showed a creator NO claimable-fee figure and no totals,
 * and read an ABSENT `creator_fee_claimable_atoms` as `0n` — so "we could not
 * read this" rendered as "you have earned nothing", on every market.
 *
 * See lib/creator-fee-summary.ts.
 */

import { describe, expect, it } from "vitest";
import {
  classifyClaimable,
  summarizeCreatorFees,
  claimAllTargets,
  type CreatorFeeEntry,
} from "@/lib/creator-fee-summary";

const USDC = "SimUsdcMint111111111111111111111111111111111";
const OTHER = "OtherMint2222222222222222222222222222222222";

function entry(over: Partial<CreatorFeeEntry> = {}): CreatorFeeEntry {
  return {
    slab: "slabA",
    claimable: { kind: "claimable", atoms: 1_000_000n },
    collateralMint: USDC,
    decimals: 6,
    isClaimAuthority: true,
    ...over,
  };
}

describe("absent is not zero", () => {
  it("reports an absent field as unknown", () => {
    // THE BUG: the API's Supabase path returned no creator-fee fields at all,
    // and the row did `detail?.creator_fee_claimable_atoms ? … : 0n`.
    expect(classifyClaimable(null)).toEqual({ kind: "unknown" });
    expect(classifyClaimable(undefined)).toEqual({ kind: "unknown" });
    expect(classifyClaimable("")).toEqual({ kind: "unknown" });
    expect(classifyClaimable("not-a-number")).toEqual({ kind: "unknown" });
  });

  it("CONTROL: a genuine zero still reads as a known zero", () => {
    // Without this the rule degrades into "0 means unknown", which is the same
    // conflation with the sign flipped — a market that really has accrued
    // nothing would sprout a permanent "balance unavailable" warning.
    expect(classifyClaimable("0")).toEqual({ kind: "none" });
  });

  it("keeps full precision on a u64 that exceeds Number.MAX_SAFE_INTEGER", () => {
    // Narrowing to number here would silently corrupt a real balance.
    const big = "18446744073709551615";
    expect(classifyClaimable(big)).toEqual({ kind: "claimable", atoms: 18446744073709551615n });
  });

  it("treats a negative counter as a bad read, not a small balance", () => {
    expect(classifyClaimable("-5")).toEqual({ kind: "unknown" });
  });
});

describe("unknown markets are excluded from every total", () => {
  it("does not fold an unreadable market in as zero", () => {
    const summary = summarizeCreatorFees([
      entry({ slab: "a", claimable: { kind: "claimable", atoms: 2_000_000n } }),
      entry({ slab: "b", claimable: { kind: "unknown" } }),
    ]);
    expect(summary.totalsByMint[0].total).toBe(2);
    expect(summary.unknownMarkets).toBe(1);
    expect(summary.knownMarkets).toBe(1);
    // The caveat is what lets the UI say "2.00 across 1 market, 1 unreadable"
    // instead of presenting 2.00 as the whole picture.
    expect(summary.marketsWithFees).toBe(1);
  });

  it("flags the case where NOTHING could be read", () => {
    // A total of 0 here is absent, not earned-nothing — the UI must not print
    // "$0.00 earned".
    const summary = summarizeCreatorFees([
      entry({ slab: "a", claimable: { kind: "unknown" } }),
      entry({ slab: "b", claimable: { kind: "unknown" } }),
    ]);
    expect(summary.allUnknown).toBe(true);
    expect(summary.totalsByMint).toEqual([]);
  });

  it("CONTROL: all-readable markets are not flagged as unknown", () => {
    const summary = summarizeCreatorFees([
      entry({ slab: "a", claimable: { kind: "none" } }),
      entry({ slab: "b", claimable: { kind: "claimable", atoms: 500_000n } }),
    ]);
    expect(summary.allUnknown).toBe(false);
    expect(summary.unknownMarkets).toBe(0);
    expect(summary.knownMarkets).toBe(2);
    expect(summary.marketsWithFees).toBe(1);
  });

  it("an empty dashboard is not 'all unknown'", () => {
    expect(summarizeCreatorFees([]).allUnknown).toBe(false);
  });
});

describe("atoms are only added within one collateral mint", () => {
  it("keeps markets with different mints in separate totals", () => {
    // Adding a quantity of one collateral token to a quantity of another
    // produces a number that means nothing — the same mistake the aggregate-OI
    // roll-up documents.
    const summary = summarizeCreatorFees([
      entry({ slab: "a", collateralMint: USDC, decimals: 6, claimable: { kind: "claimable", atoms: 1_000_000n } }),
      entry({ slab: "b", collateralMint: OTHER, decimals: 9, claimable: { kind: "claimable", atoms: 2_000_000_000n } }),
    ]);
    expect(summary.totalsByMint).toHaveLength(2);
    const usdc = summary.totalsByMint.find((t) => t.collateralMint === USDC)!;
    const other = summary.totalsByMint.find((t) => t.collateralMint === OTHER)!;
    expect(usdc.total).toBe(1);
    expect(other.total).toBe(2);
  });

  it("CONTROL: markets sharing a mint DO combine into one total", () => {
    // Guards against "never total anything", which would fix the unit mixing
    // by removing the feature the creator asked for.
    const summary = summarizeCreatorFees([
      entry({ slab: "a", claimable: { kind: "claimable", atoms: 1_500_000n } }),
      entry({ slab: "b", claimable: { kind: "claimable", atoms: 2_500_000n } }),
    ]);
    expect(summary.totalsByMint).toHaveLength(1);
    expect(summary.totalsByMint[0].total).toBe(4);
    expect(summary.totalsByMint[0].markets).toBe(2);
  });

  it("scales by each market's OWN decimals", () => {
    const summary = summarizeCreatorFees([
      entry({ collateralMint: OTHER, decimals: 9, claimable: { kind: "claimable", atoms: 1_000_000_000n } }),
    ]);
    expect(summary.totalsByMint[0].total).toBe(1);
  });

  it("counts a known balance in an unknown denomination without totalling it", () => {
    const summary = summarizeCreatorFees([
      entry({ collateralMint: null, claimable: { kind: "claimable", atoms: 9_000_000n } }),
    ]);
    expect(summary.marketsWithFees).toBe(1);
    expect(summary.totalsByMint).toEqual([]);
  });
});

describe("what the connected wallet can actually claim", () => {
  it("separates earned from claimable-by-this-wallet", () => {
    // tag 90 accepts only asset 0's asset_admin. A creator viewing a market
    // whose admin rotated still EARNED the fees but cannot claim them, and a
    // claim-all that included it would build a transaction guaranteed to fail.
    const summary = summarizeCreatorFees([
      entry({ slab: "mine", isClaimAuthority: true, claimable: { kind: "claimable", atoms: 1_000_000n } }),
      entry({ slab: "rotated", isClaimAuthority: false, claimable: { kind: "claimable", atoms: 3_000_000n } }),
    ]);
    expect(summary.totalsByMint[0].total).toBe(4);
    expect(summary.totalsByMint[0].claimableByWallet).toBe(1);
    expect(summary.claimableMarkets).toBe(1);
    expect(summary.marketsWithFees).toBe(2);
  });

  it("claim-all targets only markets with a positive balance AND authority", () => {
    expect(
      claimAllTargets([
        entry({ slab: "yes", isClaimAuthority: true, claimable: { kind: "claimable", atoms: 1n } }),
        entry({ slab: "no-auth", isClaimAuthority: false, claimable: { kind: "claimable", atoms: 1n } }),
        entry({ slab: "zero", isClaimAuthority: true, claimable: { kind: "none" } }),
        entry({ slab: "unknown", isClaimAuthority: true, claimable: { kind: "unknown" } }),
      ]),
    ).toEqual(["yes"]);
  });

  it("CONTROL: claim-all is empty rather than speculative when nothing qualifies", () => {
    // An 'unknown' balance must not be optimistically submitted — tag 90 is
    // exact-amount and would reject it.
    expect(claimAllTargets([entry({ claimable: { kind: "unknown" } })])).toEqual([]);
  });
});
