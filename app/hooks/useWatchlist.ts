"use client";

/**
 * React binding for the market watchlist (lib/watchlist.ts).
 *
 * `useSyncExternalStore` rather than local state, so every surface that shows a
 * watch control stays in step without prop-drilling: watching a market from the
 * markets table updates the trade page's button and the portfolio panel in the
 * same tick, and a change in another tab lands here too.
 */

import { useCallback, useMemo } from "react";
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

  // O(1) membership for the markets table, which asks once per row on every
  // render. `.includes` per row would be O(n*m) across a few hundred markets.
  const watchedSet = useMemo(() => new Set(watchlist), [watchlist]);

  return {
    watchlist,
    watchedSet,
    isWatched: useCallback((slab: string) => watchedSet.has(slab), [watchedSet]),
    watch,
    unwatch,
    toggle,
    full: isWatchlistFull(watchlist),
    max: WATCHLIST_MAX,
  };
}
