/**
 * The portfolio overview used to carry a panel called Watchlist.tsx that
 * fetched `/api/markets?limit=10` and listed the first ten markets — no
 * curation, no persistence, no per-user state. This is the real thing.
 *
 * See lib/watchlist.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseWatchlist,
  addSlab,
  removeSlab,
  isWatchlistFull,
  watchMarket,
  unwatchMarket,
  toggleWatchMarket,
  isWatched,
  getWatchlistSnapshot,
  getWatchlistServerSnapshot,
  subscribeWatchlist,
  resetWatchlistCacheForTests,
  WATCHLIST_STORAGE_KEY,
  WATCHLIST_MAX,
} from "@/lib/watchlist";

// Real base58, 32-44 chars — the addresses this stores.
const A = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const B = "3t67LQPdgiSqGvXsYff3Pzv2uHtM1zZ7f29HsnEzb6vJ";
const C = "7mgX3bkzEivRrCffCJ7XzqfAp3gpjm63RNinwDhr7b41";

describe("reading whatever is in storage", () => {
  it("drops entries that are not market addresses", () => {
    // Storage is shared with every other script on the origin and survives
    // schema changes, so its contents are untrusted input, not our data.
    expect(parseWatchlist([A, "", "not a slab", 7, null, { x: 1 }, B])).toEqual([A, B]);
  });

  it("de-duplicates", () => {
    expect(parseWatchlist([A, A, B, A])).toEqual([A, B]);
  });

  it("survives a value that is not an array at all", () => {
    for (const junk of [null, undefined, 42, "abc", { list: [A] }]) {
      expect(parseWatchlist(junk)).toEqual([]);
    }
  });

  it("truncates a list longer than the cap", () => {
    const many = Array.from({ length: WATCHLIST_MAX + 10 }, () => A);
    expect(parseWatchlist(many).length).toBeLessThanOrEqual(WATCHLIST_MAX);
  });
});

describe("adding", () => {
  it("puts the newest first", () => {
    expect(addSlab([B], A)).toEqual([A, B]);
  });

  it("returns the SAME array when already watched, so nothing re-renders", () => {
    const list = [A, B];
    expect(addSlab(list, A)).toBe(list);
  });

  it("rejects anything that is not a market address", () => {
    const list = [A];
    expect(addSlab(list, "nope")).toBe(list);
    expect(addSlab(list, "")).toBe(list);
  });

  it("REFUSES at the cap rather than evicting the oldest", () => {
    // Evicting would silently drop a market the user deliberately chose. The
    // refusal is visible, and the button surfaces it.
    const full = Array.from({ length: 3 }, (_, i) => [A, B, C][i]);
    const out = addSlab(full, "5JUTyfARvXhBPoLJmKXmhCB2vPvCgWJx8ZWVbBWvJ8Hd", 3);
    expect(out).toBe(full);
    expect(isWatchlistFull(full, 3)).toBe(true);
  });

  it("CONTROL: below the cap it still adds", () => {
    // Guards against "always refuse", which would fix the eviction by breaking
    // the feature.
    expect(addSlab([A], B, 3)).toEqual([B, A]);
    expect(isWatchlistFull([A], 3)).toBe(false);
  });
});

describe("removing one market", () => {
  it("takes out only that market", () => {
    expect(removeSlab([A, B, C], B)).toEqual([A, C]);
  });

  it("returns the SAME array when it was not watched", () => {
    const list = [A, B];
    expect(removeSlab(list, C)).toBe(list);
  });

  it("CONTROL: removing does not clear the whole list", () => {
    // The per-row control removes one market; a version that wiped everything
    // would pass a naive 'is it gone?' assertion.
    const out = removeSlab([A, B, C], A);
    expect(out).toHaveLength(2);
    expect(out).toContain(B);
    expect(out).toContain(C);
  });
});

describe("the browser store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetWatchlistCacheForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    resetWatchlistCacheForTests();
  });

  it("persists across a reload", () => {
    watchMarket(A);
    resetWatchlistCacheForTests(); // simulates a fresh page load
    expect(isWatched(A)).toBe(true);
  });

  it("returns a STABLE reference while nothing changes", () => {
    // useSyncExternalStore re-reads on every render; a fresh array each call is
    // an infinite render loop, not a subtle inefficiency.
    watchMarket(A);
    expect(getWatchlistSnapshot()).toBe(getWatchlistSnapshot());
  });

  it("changes the reference when the list actually changes", () => {
    const before = getWatchlistSnapshot();
    watchMarket(A);
    expect(getWatchlistSnapshot()).not.toBe(before);
  });

  it("notifies subscribers on add and on remove", () => {
    const seen = vi.fn();
    const unsub = subscribeWatchlist(seen);
    watchMarket(A);
    expect(seen).toHaveBeenCalledTimes(1);
    unwatchMarket(A);
    expect(seen).toHaveBeenCalledTimes(2);
    unsub();
    watchMarket(B);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("toggles both ways", () => {
    toggleWatchMarket(A);
    expect(isWatched(A)).toBe(true);
    toggleWatchMarket(A);
    expect(isWatched(A)).toBe(false);
  });

  it("keeps working when storage throws", () => {
    // Private mode, blocked site data, some embedded webviews. A watchlist that
    // cannot persist must degrade to in-memory, not take the page down.
    const boom = () => { throw new Error("blocked"); };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom, removeItem: boom, clear: boom });
    resetWatchlistCacheForTests();
    expect(() => watchMarket(A)).not.toThrow();
    expect(isWatched(A)).toBe(true); // in-memory for the session
  });

  it("ignores corrupt JSON in storage", () => {
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, "{not json");
    resetWatchlistCacheForTests();
    expect(getWatchlistSnapshot()).toEqual([]);
  });

  it("server snapshot is a stable empty list", () => {
    // Returning a new [] per call would loop during hydration.
    expect(getWatchlistServerSnapshot()).toBe(getWatchlistServerSnapshot());
    expect(getWatchlistServerSnapshot()).toEqual([]);
  });
});
