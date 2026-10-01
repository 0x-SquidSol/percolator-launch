"use client";

import { useEffect, useState } from "react";
import { parseLpCostBasis, type LpCostBasis } from "@/lib/lp-earned";

/**
 * The indexer's Earn LP-vault cost basis for (slab, wallet) — percolator-indexer#207.
 *
 * `claimShares` (held + pending) is a dependency on purpose: when the on-chain
 * claim changes after a deposit/redemption, the basis is re-fetched, and until
 * the indexer catches up `computeExactLpEarned` sees the share counts disagree
 * and reports "out-of-sync" instead of pairing a new balance with an old basis.
 * Returns null when there is no wallet, no data, or the request failed.
 */
export function useLpCostBasis(
  slabAddress: string | null | undefined,
  wallet: string | null | undefined,
  claimShares: bigint,
): LpCostBasis | null {
  const [basis, setBasis] = useState<LpCostBasis | null>(null);
  const claimKey = claimShares.toString();

  useEffect(() => {
    setBasis(null);
    if (!slabAddress || !wallet) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/earn/${slabAddress}/position/${wallet}`);
        if (!res.ok) return;
        const parsed = parseLpCostBasis(await res.json());
        if (!cancelled) setBasis(parsed);
      } catch {
        // Decoration only: the card renders "unavailable" on any failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slabAddress, wallet, claimKey]);

  return basis;
}
