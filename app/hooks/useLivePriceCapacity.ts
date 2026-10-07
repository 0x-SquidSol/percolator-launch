"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MARKET_REGISTERED_EVENT } from "@/lib/keeper-register-client";

/**
 * #3320: the connected creator's live-priced markets and the per-creator ceiling, from
 * GET /api/playground/keeper-capacity (the same filter and caps keeper-register enforces).
 *
 * "unknown" until read, and on ANY failure (devnet-only route, lapsed session, 503): callers
 * never block or hide anything on unknown, so a failed read behaves exactly like before.
 * Re-read when the wallet changes and whenever a market registers on this page.
 */
export interface LivePriceCapacity {
  status: "unknown" | "ok" | "atLimit";
  /** The wallet's live-priced markets. A slab in here is never refused by the ceiling. */
  activeSlabs: ReadonlySet<string>;
  max: number | null;
}

const UNKNOWN: LivePriceCapacity = { status: "unknown", activeSlabs: new Set(), max: null };

/** True when a NEW enrollment of `slab` would be refused by the per-creator ceiling. */
export function cappedFor(cap: LivePriceCapacity, slab: string): boolean {
  return cap.status === "atLimit" && !cap.activeSlabs.has(slab);
}

export function parseCapacity(body: unknown): LivePriceCapacity {
  const b = body as { activeSlabs?: unknown; max?: unknown; atLimit?: unknown } | null;
  if (!b || !Array.isArray(b.activeSlabs) || typeof b.max !== "number" || typeof b.atLimit !== "boolean") return UNKNOWN;
  const activeSlabs = new Set(b.activeSlabs.filter((s): s is string => typeof s === "string"));
  return { status: b.atLimit ? "atLimit" : "ok", activeSlabs, max: b.max };
}

export function useLivePriceCapacity(wallet: string | null, enabled = true): LivePriceCapacity & { refresh: () => void } {
  const [cap, setCap] = useState<LivePriceCapacity>(UNKNOWN);
  const reqId = useRef(0);

  const refresh = useCallback(() => {
    const id = ++reqId.current;
    if (!wallet || !enabled) {
      setCap(UNKNOWN);
      return;
    }
    void fetch(`/api/playground/keeper-capacity?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? parseCapacity(await r.json()) : UNKNOWN))
      .catch(() => UNKNOWN)
      .then((next) => {
        if (id === reqId.current) setCap(next);
      });
  }, [wallet, enabled]);

  useEffect(() => {
    setCap(UNKNOWN);
    refresh();
    if (typeof window === "undefined") return;
    window.addEventListener(MARKET_REGISTERED_EVENT, refresh);
    return () => window.removeEventListener(MARKET_REGISTERED_EVENT, refresh);
  }, [refresh]);

  return { ...cap, refresh };
}
