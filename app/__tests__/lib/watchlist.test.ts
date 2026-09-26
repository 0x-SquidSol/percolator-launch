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
  handleStorageEventForTests,
  WATCHLIST_STORAGE_KEY,
  WATCHLIST_MAX,
} from "@/lib/watchlist";

// Real base58, 32-44 chars — the addresses this stores.
const A = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const B = "3t67LQPdgiSqGvXsYff3Pzv2uHtM1zZ7f29HsnEzb6vJ";
const C = "7mgX3bkzEivRrCffCJ7XzqfAp3gpjm63RNinwDhr7b41";

/** n DISTINCT 43-char base58 addresses (no 0/O/I/l), for cap tests. */
function distinctSlabs(n: number): string[] {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return Array.from({ length: n }, (_, i) => {
    const suffix = String(i).split("").map((d) => alphabet[Number(d)]).join("");
    return ("Az" + alphabet.repeat(2)).slice(0, 43 - suffix.length) + suffix;
  });
}

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
    // DISTINCT addresses. The first version of this test used WATCHLIST_MAX+10
    // copies of ONE address: de-dup collapsed it to length 1, so the assertion
    // passed no matter what the cap did — deleting the cap entirely survived
    // it. A test whose fixture cannot reach the branch is not coverage.
    const many = distinctSlabs(WATCHLIST_MAX + 10);
    expect(parseWatchlist(many)).toHaveLength(WATCHLIST_MAX);
  });

  it("keeps the FIRST entries when truncating, not a random window", () => {
    const many = distinctSlabs(WATCHLIST_MAX + 5);
    const out = parseWatchlist(many);
    expect(out[0]).toBe(many[0]);
    expect(out[WATCHLIST_MAX - 1]).toBe(many[WATCHLIST_MAX - 1]);
    expect(out).not.toContain(many[WATCHLIST_MAX]);
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

  it("holds MORE THAN ONE market, newest first", () => {
    // Every store test used to touch only one address, so a store physically
    // incapable of holding two — commit(next.slice(0,1)), or watchMarket
    // bypassing addSlab entirely — passed the whole suite. The panel renders
    // this list directly, so this is the shipped shape.
    watchMarket(A);
    watchMarket(B);
    watchMarket(C);
    expect(getWatchlistSnapshot()).toEqual([C, B, A]);
    resetWatchlistCacheForTests();
    expect(getWatchlistSnapshot()).toEqual([C, B, A]);
  });

  it("persists a REMOVAL, not just an addition", () => {
    // `writeStorage` only on growth would pass every other test here: remove a
    // market, reload, and it is back.
    watchMarket(A);
    watchMarket(B);
    unwatchMarket(A);
    resetWatchlistCacheForTests();
    expect(isWatched(A)).toBe(false);
    expect(isWatched(B)).toBe(true);
  });

  it("toggles OFF a market that was loaded from storage, not just one added this session", () => {
    // The real first click after a reload: `current` is null and must be
    // hydrated before the toggle decides direction. Reading `current ?? []`
    // instead would route to add, no-op, and the star would never turn off.
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify([A]));
    resetWatchlistCacheForTests();
    toggleWatchMarket(A);
    expect(isWatched(A)).toBe(false);
  });

  it("writes under the exact documented key", () => {
    // Renaming the key silently wipes every existing user's list. Importing the
    // constant would make this test blind to that, so the literal is hardcoded.
    watchMarket(A);
    expect(window.localStorage.getItem("perc:watchlist:v1")).toBe(JSON.stringify([A]));
  });

  it("hands subscribers a snapshot that already contains the change", () => {
    // emit() before `current` is updated is the classic useSyncExternalStore
    // tearing bug, and a call-count assertion cannot see it.
    const seen: readonly string[][] = [];
    const unsub = subscribeWatchlist(() => {
      (seen as string[][]).push([...getWatchlistSnapshot()]);
    });
    watchMarket(A);
    expect(seen[0]).toEqual([A]);
    unsub();
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

describe("one shared storage listener, not one per subscriber", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetWatchlistCacheForTests();
  });

  it("attaches once for many subscribers and detaches on the last", () => {
    // The markets table mounts a watch control PER ROW and grows by infinite
    // scroll, so subscribers reach the hundreds. A listener each meant one
    // cross-tab edit ran N handlers, each re-parsing storage and notifying all
    // N subscribers — N re-parses and N^2 callbacks for a single change.
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");

    const unsubs = [vi.fn(), vi.fn(), vi.fn()].map((cb) => subscribeWatchlist(cb));
    const storageAdds = add.mock.calls.filter(([type]) => type === "storage").length;
    expect(storageAdds).toBe(1);

    unsubs[0]();
    unsubs[1]();
    expect(remove.mock.calls.filter(([type]) => type === "storage").length).toBe(0);

    unsubs[2]();
    expect(remove.mock.calls.filter(([type]) => type === "storage").length).toBe(1);

    add.mockRestore();
    remove.mockRestore();
  });

  it("adopts another tab's change and notifies subscribers once each", () => {
    const seen = vi.fn();
    const unsub = subscribeWatchlist(seen);

    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify([A, B]));
    handleStorageEventForTests({ key: WATCHLIST_STORAGE_KEY } as StorageEvent);

    expect(seen).toHaveBeenCalledTimes(1);
    expect(getWatchlistSnapshot()).toEqual([A, B]);
    unsub();
  });

  it("CONTROL: ignores a storage event for someone else's key", () => {
    // Without the key check, every unrelated write on the origin would re-parse
    // and re-render every watch control on the page.
    watchMarket(A);
    const seen = vi.fn();
    const unsub = subscribeWatchlist(seen);
    handleStorageEventForTests({ key: "perc:entry:something" } as StorageEvent);
    expect(seen).not.toHaveBeenCalled();
    unsub();
  });

  it("does not churn subscribers when another tab wrote the SAME list", () => {
    watchMarket(A);
    const seen = vi.fn();
    const unsub = subscribeWatchlist(seen);
    // Storage already holds exactly [A]; re-announcing it changes nothing.
    handleStorageEventForTests({ key: WATCHLIST_STORAGE_KEY } as StorageEvent);
    expect(seen).not.toHaveBeenCalled();
    unsub();
  });
});
