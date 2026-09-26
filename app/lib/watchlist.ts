"use client";

/**
 * Market watchlist — the markets a user chose to follow.
 *
 * WHAT THIS REPLACES
 *
 * The portfolio overview used to carry a panel headed "Markets" that fetched
 * `/api/markets?limit=10` and listed the first ten. It was called Watchlist.tsx
 * but nothing about it watched anything: no curation, no persistence, no
 * per-user state. It was the markets directory truncated to ten rows, on a page
 * about the user's own positions, linking to the directory it copied. This is
 * the feature that slot was pretending to be.
 *
 * BROWSER-LOCAL, NOT WALLET-SCOPED, and deliberately so: this is a display
 * preference, the same class of thing as the chart overlay prefs already
 * persisted here (hooks/useChartOverlayPrefs.ts, key `perc:chart:overlays`;
 * lib/chart-overlays.ts holds only the pure helpers), and keying it by
 * wallet would mean a visitor cannot watch anything until they connect — on the
 * one page (/markets) that is most useful to someone still deciding. The
 * trade-off, stated rather than hidden: a watchlist does not follow the user to
 * another device, and someone else using the same browser profile sees it.
 * Nothing sensitive lives here — it is a list of public market addresses.
 *
 * STORAGE IS NEVER TRUSTED. Every read and write is wrapped: localStorage
 * throws in private mode, with site data blocked, and in some embedded
 * webviews. A watchlist that cannot persist degrades to an in-memory one for
 * the session rather than breaking the page it sits on.
 */

/** Colon-separated, matching `perc:entry:` in lib/entry-price.ts. */
export const WATCHLIST_STORAGE_KEY = "perc:watchlist:v1";

/**
 * Upper bound on watched markets.
 *
 * Not arbitrary: this list is read on every render of the markets table (one
 * membership test per row) and serialised on every change, and a watchlist is a
 * shortlist — past a few dozen it is just the markets page with extra steps.
 */
export const WATCHLIST_MAX = 50;

/** Base58 addresses only. Anything else in storage is someone else's data, a
 *  corrupted write, or a stale schema — dropped rather than rendered. */
const SLAB_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Normalise whatever came out of storage into a usable list.
 *
 * Tolerates every shape a bad/legacy/hostile write could leave: not an array,
 * nested junk, duplicates, non-strings, over-length. Returns a NEW array, and
 * never throws.
 */
export function parseWatchlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const slab = entry.trim();
    if (!SLAB_RE.test(slab) || seen.has(slab)) continue;
    seen.add(slab);
    out.push(slab);
    if (out.length >= WATCHLIST_MAX) break;
  }
  return out;
}

/**
 * Add a market, newest first.
 *
 * Returns the SAME array when nothing changes — already watched, invalid, or
 * the list is full — so callers can skip a write and a re-render.
 *
 * At the cap it REFUSES rather than evicting the oldest entry. Evicting would
 * silently drop a market the user deliberately chose; refusing is visible, and
 * `isWatchlistFull` lets the button say why.
 */
export function addSlab(
  list: readonly string[],
  slab: string,
  max: number = WATCHLIST_MAX,
): string[] {
  if (!SLAB_RE.test(slab)) return list as string[];
  if (list.includes(slab)) return list as string[];
  if (list.length >= max) return list as string[];
  return [slab, ...list];
}

/** Remove one market. Returns the SAME array when it was not watched. */
export function removeSlab(list: readonly string[], slab: string): string[] {
  if (!list.includes(slab)) return list as string[];
  return list.filter((s) => s !== slab);
}

export function isWatchlistFull(list: readonly string[], max: number = WATCHLIST_MAX): boolean {
  return list.length >= max;
}

// ── Browser store ───────────────────────────────────────────────────────────
//
// useSyncExternalStore requires getSnapshot to return a STABLE reference while
// nothing has changed — returning a fresh array each call is an infinite render
// loop. `current` is that reference and is only ever replaced by a real change.

const EMPTY: readonly string[] = Object.freeze([]);
let current: readonly string[] | null = null;
const listeners = new Set<() => void>();

function readStorage(): string[] {
  try {
    const raw = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) return [];
    return parseWatchlist(JSON.parse(raw));
  } catch {
    // Unparseable, blocked, or unavailable — an empty watchlist, not a crash.
    return [];
  }
}

function writeStorage(next: readonly string[]): void {
  try {
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota, private mode, blocked storage: keep the in-memory list so the
    // session still behaves, and accept that it will not survive a reload.
  }
}

function emit(): void {
  for (const l of listeners) l();
}

/** The current watchlist. Stable reference between changes. */
export function getWatchlistSnapshot(): readonly string[] {
  if (typeof window === "undefined") return EMPTY;
  if (current === null) current = readStorage();
  return current;
}

/** Server render has no storage, and must return the SAME reference every call. */
export function getWatchlistServerSnapshot(): readonly string[] {
  return EMPTY;
}

/**
 * ONE window listener for the whole app, attached with the first subscriber and
 * detached with the last — NOT one per subscriber.
 *
 * The markets table mounts a watch control per row and grows by infinite
 * scroll, so subscribers reach the hundreds. A listener each would mean every
 * cross-tab edit ran N handlers, each re-reading and re-parsing storage and
 * each notifying all N subscribers: N re-parses and N^2 callbacks for one
 * change in another tab.
 */
function onStorageEvent(e: StorageEvent): void {
  // key === null is a storage.clear(); anything else that is not ours is noise.
  if (e.key !== null && e.key !== WATCHLIST_STORAGE_KEY) return;
  const next = readStorage();
  // Same-value writes from another tab must not churn every subscriber.
  if (current !== null && sameList(current, next)) return;
  current = next;
  emit();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function subscribeWatchlist(onChange: () => void): () => void {
  const first = listeners.size === 0;
  listeners.add(onChange);
  if (first && typeof window !== "undefined") {
    window.addEventListener("storage", onStorageEvent);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorageEvent);
    }
  };
}

/** Test seam — drives the cross-tab path without a real StorageEvent. */
export function handleStorageEventForTests(e: StorageEvent): void {
  onStorageEvent(e);
}

function commit(next: readonly string[]): readonly string[] {
  if (next === current) return current;
  current = next;
  writeStorage(next);
  emit();
  return next;
}

export function watchMarket(slab: string): readonly string[] {
  return commit(addSlab(getWatchlistSnapshot(), slab));
}

export function unwatchMarket(slab: string): readonly string[] {
  return commit(removeSlab(getWatchlistSnapshot(), slab));
}

export function toggleWatchMarket(slab: string): readonly string[] {
  return getWatchlistSnapshot().includes(slab) ? unwatchMarket(slab) : watchMarket(slab);
}

export function isWatched(slab: string): boolean {
  return getWatchlistSnapshot().includes(slab);
}

/** Test seam — drops the cached snapshot so the next read hits storage. */
export function resetWatchlistCacheForTests(): void {
  current = null;
}
