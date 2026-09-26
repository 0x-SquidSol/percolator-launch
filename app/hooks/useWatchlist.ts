"use client";

/**
 * React binding for the market watchlist (lib/watchlist.ts).
 *
 * `useSyncExternalStore` rather than local state, so every surface that shows a
 * watch control stays in step without prop-drilling: watching a market from the
 * markets table updates the trade page's button and the portfolio panel in the
 * same tick, and a change in another tab lands here too.
 */

import { useCallback } from "react";
import { useSyncExternalStore } from "react";
import {
  subscribeWatchlist,
  getWatchlistSnapshot,
  getWatchlistServerSnapshot,
  watchMarket,
  unwatchMarket,
  toggleWatchMarket,
  isWatchlistFull,
  WATCHLIST_MAX,
} from "@/lib/watchlist";

export function useWatchlist() {
  const watchlist = useSyncExternalStore(
    subscribeWatchlist,
    getWatchlistSnapshot,
    getWatchlistServerSnapshot,
  );

  const watch = useCallback((slab: string) => { watchMarket(slab); }, []);
  const unwatch = useCallback((slab: string) => { unwatchMarket(slab); }, []);
  const toggle = useCallback((slab: string) => { toggleWatchMarket(slab); }, []);

  // Deliberately NOT a memoised Set. Every consumer today asks about exactly
  // one slab, and the markets table mounts one control PER ROW — so a Set per
  // component would allocate hundreds of them to answer a single lookup each,
  // which is strictly worse than the `.includes` it would replace. Revisit only
  // if a consumer appears that tests many slabs at once.
  return {
    watchlist,
    isWatched: useCallback((slab: string) => watchlist.includes(slab), [watchlist]),
    watch,
    unwatch,
    toggle,
    full: isWatchlistFull(watchlist),
    max: WATCHLIST_MAX,
  };
}
