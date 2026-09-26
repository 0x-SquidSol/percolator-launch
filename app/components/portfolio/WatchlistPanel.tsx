"use client";

/**
 * The watchlist on the portfolio overview — markets the user chose to follow.
 *
 * This fills the slot left by the old "Markets" panel, which fetched
 * `/api/markets?limit=10` and listed whatever came back. That panel was named
 * Watchlist.tsx but watched nothing, and a directory of every market already
 * has its own page, which the panel linked to. This one shows only what the
 * user picked, and each row can be removed.
 *
 * One bulk request for the whole list (`/api/markets?limit=500`, the same call
 * /portfolio and /my-markets already use) rather than one per watched market:
 * the per-slab route blocks on an on-chain LP scan and costs 500-1000ms each.
 */

import { FC, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWatchlist } from "@/hooks/useWatchlist";
import { MarketLogo } from "@/components/market/MarketLogo";
import { formatUsdFromNumber } from "@/lib/format";

interface DirectoryRow {
  slab_address: string;
  symbol: string | null;
  name: string | null;
  logo_url: string | null;
  mainnet_ca: string | null;
  mint_address: string | null;
  last_price: number | null;
}

function shorten(addr: string): string {
  return addr.slice(0, 4) + "…" + addr.slice(-4);
}

export const WatchlistPanel: FC = () => {
  const { watchlist, unwatch } = useWatchlist();
  const [rows, setRows] = useState<Record<string, DirectoryRow>>({});
  // Distinguishes "still loading" from "the directory has nothing for these
  // slabs", so a watched market never silently vanishes from its own list.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (watchlist.length === 0) { setLoaded(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/markets?limit=500", { headers: { Accept: "application/json" } });
        if (!res.ok) return;
        const body = (await res.json()) as { markets?: unknown };
        if (cancelled || !Array.isArray(body.markets)) return;
        const next: Record<string, DirectoryRow> = {};
        for (const raw of body.markets) {
          if (!raw || typeof raw !== "object") continue;
          const r = raw as Record<string, unknown>;
          const slab = typeof r.slab_address === "string" ? r.slab_address : null;
          if (!slab) continue;
          next[slab] = {
            slab_address: slab,
            symbol: typeof r.symbol === "string" ? r.symbol : null,
            name: typeof r.name === "string" ? r.name : null,
            logo_url: typeof r.logo_url === "string" ? r.logo_url : null,
            mainnet_ca: typeof r.mainnet_ca === "string" ? r.mainnet_ca : null,
            mint_address: typeof r.mint_address === "string" ? r.mint_address : null,
            last_price: typeof r.last_price === "number" ? r.last_price : null,
          };
        }
        setRows(next);
      } catch {
        // Leave rows empty — each entry still renders by address and stays
        // removable, which is the part the user needs.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
    // Refetch when the SET of watched markets changes, not on every toggle of
    // an already-fetched one.
  }, [watchlist.length]);

  const entries = useMemo(
    () => watchlist.map((slab) => ({ slab, row: rows[slab] ?? null })),
    [watchlist, rows],
  );

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
          Watchlist
        </p>
        <Link
          href="/markets"
          className="text-[10px] text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]"
        >
          Browse Markets →
        </Link>
      </div>

      {watchlist.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-[11px] text-[var(--text-secondary)]">No markets watched yet</p>
          <p className="mt-1 text-[10px] text-[var(--text-dim)]">
            Add one with the ☆ on any market row, or on a market&apos;s own page.
          </p>
        </div>
      ) : (
        <div className="max-h-[280px] overflow-y-auto">
          {entries.map(({ slab, row }) => (
            <div
              key={slab}
              className="flex items-center gap-2 border-b border-[var(--border)]/40 px-5 py-2.5 last:border-b-0 transition-colors hover:bg-[var(--accent)]/[0.04]"
            >
              <Link href={`/trade/${slab}`} className="flex min-w-0 flex-1 items-center gap-2">
                <MarketLogo
                  logoUrl={row?.logo_url ?? undefined}
                  mintAddress={row?.mint_address ?? undefined}
                  mainnetCa={row?.mainnet_ca ?? null}
                  symbol={row?.symbol ?? undefined}
                  size="sm"
                />
                <span className="truncate text-[11px] font-semibold text-[var(--text)]">
                  {/* Falls back to the address rather than a blank row — and
                      only once the directory has actually answered, so a slow
                      fetch does not look like an unknown market. */}
                  {row?.symbol ? `${row.symbol}/USD` : loaded ? shorten(slab) : "…"}
                </span>
              </Link>

              <span
                className="shrink-0 text-[11px] tabular-nums text-[var(--text-secondary)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {row?.last_price != null ? formatUsdFromNumber(row.last_price) : "—"}
              </span>

              {/* Per-row remove — takes this market off the list, nothing else. */}
              <button
                type="button"
                onClick={() => unwatch(slab)}
                aria-label={`Remove ${row?.symbol ?? shorten(slab)} from your watchlist`}
                title="Remove from watchlist"
                className="shrink-0 border border-[var(--border)] px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-wider text-[var(--text-dim)] transition-colors hover:border-[var(--short)]/50 hover:text-[var(--short)]"
              >
                remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
