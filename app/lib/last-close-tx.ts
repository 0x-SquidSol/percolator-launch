/**
 * v2.2 QA minor: keep the last close's transaction visible. After a close the position row and the close form go
 * away with the position, and the signature went with them. useClosePosition records it here per market; the
 * empty states (ticket Close tab, positions dock) render a link to it for LAST_CLOSE_TTL_MS.
 */
import { useSyncExternalStore } from "react";

export const LAST_CLOSE_TTL_MS = 10 * 60_000;

interface Entry { signature: string; at: number }
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

export function recordCloseTx(slab: string, signature: string | null | undefined, now = Date.now()): void {
  if (!signature) return;
  entries.set(slab, { signature, at: now });
  for (const l of listeners) l();
}

export function lastCloseTx(slab: string, now = Date.now()): string | null {
  const e = entries.get(slab);
  if (!e) return null;
  if (now - e.at > LAST_CLOSE_TTL_MS) {
    entries.delete(slab);
    return null;
  }
  return e.signature;
}

/** Test seam. */
export function __clearCloseTxs(): void {
  entries.clear();
}

export function useLastCloseTx(slab: string): string | null {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => lastCloseTx(slab),
    () => null,
  );
}
