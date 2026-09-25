"use client";

/**
 * useMarketFillCap — the market's trade-size limits, for the order ticket.
 *
 * Surfaces the matcher's `maxFillAbs` / `maxInventoryAbs` (immutable, cached
 * forever) AND the LP's live `inventoryBase` (changes with every fill) so the
 * ticket can refuse an order the market physically cannot fill INSTEAD of
 * letting the user sign a transaction that reverts with a bare
 * `InvalidAccountData`. Two distinct rejections are prevented:
 *
 *   1. size > maxFillAbs                      — over the per-trade cap
 *   2. |inventory ± size| > maxInventoryAbs   — over the LP's NET exposure cap
 *
 * (2) is why the live inventory is here: a one-sided market fills up, and
 * from then on even small same-direction orders bounce while the other
 * direction still works. See lib/marketCapacity.ts for the sign conventions.
 *
 * The caps resolve once (process-wide cache in getMatcherCaps); the inventory
 * fetches immediately, then refreshes on a 20s visible-tab poll — every fill
 * moves it, and telling the user how much room is left is the whole point.
 */
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { getMatcherCaps, getMatcherInventory, type MatcherCaps } from "@/lib/matcherCaps";
import { pollWhenVisible } from "@/lib/pollWhenVisible";

const INVENTORY_POLL_MS = 20_000;

export interface MarketFillLimits extends MatcherCaps {
  /**
   * LP's live net inventory in base q units (positive = LP long), or null
   * while unknown. Null disables the inventory check — never the fill cap.
   */
  inventoryBase: bigint | null;
}

export function useMarketFillCap(slabAddress: string): MarketFillLimits | null {
  const { connection } = useConnectionCompat();
  const { programId } = useSlabState();
  const [caps, setCaps] = useState<MatcherCaps | null>(null);
  const [inventoryBase, setInventoryBase] = useState<bigint | null>(null);

  // PERC-9204: stable primitive standing in for `programId` below. The effect
  // BLANKS caps+inventory before refetching, which is right on a real market
  // switch and wrong on a poll. SlabProvider rebuilds programId as a brand-new
  // PublicKey on every slab poll (`programId: owner ?? s.programId`, where
  // `owner` comes fresh off each getAccountInfo), and parseSlab only
  // short-circuits on byte-identical slabs — so on any market with activity
  // the identity churned every ~3s, the effect re-ran, and the capacity row
  // blinked out. base58 is stable across polls and still changes on a real
  // program change. Mirrors usePositionNft.ts and useUserAccount.ts.
  const programIdStr = programId?.toBase58() ?? null;

  useEffect(() => {
    // Reset on market switch: without this, market B's order briefly
    // validates against market A's caps and inventory.
    setCaps(null);
    setInventoryBase(null);
    if (!programIdStr || !slabAddress) return;
    let cancelled = false;
    let dispose: (() => void) | null = null;
    let slabPk: PublicKey;
    let programPk: PublicKey;
    try {
      slabPk = new PublicKey(slabAddress);
      programPk = new PublicKey(programIdStr);
    } catch {
      return; // malformed address — nothing to resolve
    }
    // Live inventory: one immediate read (pollWhenVisible does NOT tick on
    // start), then the visible-tab poll. In-flight guard so a slow RPC can't
    // stack requests.
    let fetching = false;
    const refresh = () => {
      if (fetching) return;
      fetching = true;
      void getMatcherInventory(connection, programPk, slabPk)
        .then((inv) => {
          if (!cancelled && inv !== null) setInventoryBase(inv);
        })
        .finally(() => {
          fetching = false;
        });
    };
    // Inventory polling starts ONLY once caps resolve: a market with no
    // matcher config (v12 slab, mock slab, broken launch) would otherwise
    // re-run a full getProgramAccounts scan every 20s per mounted instance,
    // forever, for nothing.
    void getMatcherCaps(connection, programPk, slabPk).then((c) => {
      if (cancelled) return;
      setCaps(c);
      if (c) {
        refresh();
        dispose = pollWhenVisible(refresh, INVENTORY_POLL_MS);
      }
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [connection, programIdStr, slabAddress]);

  if (!caps) return null;
  return { ...caps, inventoryBase };
}
