"use client";

/**
 * Add/remove a market from the watchlist.
 *
 * RENDERS AS A SPAN, NOT A BUTTON. Both call sites sit inside a row that is
 * itself a link to the market: a nested <button> inside an <a> is invalid HTML
 * and browsers recover from it unpredictably. `role="button"` plus explicit
 * key handling keeps it operable by keyboard while staying a legal descendant,
 * and the handler stops propagation so watching a market never also navigates
 * away from the page you were scanning.
 *
 * Styled to match the row badges already on the markets table (square, hairline
 * border, 8-9px uppercase) rather than introducing a new control shape.
 */

import { FC, useCallback } from "react";
import { useWatchlist } from "@/hooks/useWatchlist";

interface WatchButtonProps {
  slab: string;
  /** Named in the tooltip so the control says WHICH market it affects. */
  symbol?: string | null;
  /** `icon` for dense rows (glyph only), `label` where there is room for a word. */
  variant?: "icon" | "label";
  className?: string;
}

export const WatchButton: FC<WatchButtonProps> = ({
  slab,
  symbol,
  variant = "icon",
  className = "",
}) => {
  const { isWatched, toggle, full } = useWatchlist();
  const watched = isWatched(slab);
  // Being full must not disable REMOVING — that would strand a user at the cap
  // with no way down.
  const blocked = full && !watched;

  const activate = useCallback(
    (e: { preventDefault: () => void; stopPropagation: () => void }) => {
      e.preventDefault();
      e.stopPropagation();
      if (blocked) return;
      toggle(slab);
    },
    [blocked, toggle, slab],
  );

  const name = symbol ?? "this market";
  const title = blocked
    ? "Watchlist is full — remove a market first"
    : watched
      ? `Remove ${name} from your watchlist`
      : `Add ${name} to your watchlist`;

  return (
    <span
      role="button"
      tabIndex={blocked ? -1 : 0}
      aria-pressed={watched}
      aria-disabled={blocked || undefined}
      aria-label={title}
      title={title}
      onClick={activate}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") activate(e); }}
      className={[
        "inline-flex shrink-0 select-none items-center justify-center border px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-wider transition-colors",
        blocked
          ? "cursor-not-allowed border-[var(--border)] text-[var(--text-dim)] opacity-50"
          : "cursor-pointer",
        watched && !blocked
          ? "border-[var(--accent)]/50 bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20"
          : !blocked
            ? "border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--accent)]/40 hover:text-[var(--accent)]"
            : "",
        className,
      ].join(" ")}
    >
      {variant === "icon"
        ? (watched ? "★" : "☆")
        : (watched ? "★ watching" : "☆ watch")}
    </span>
  );
};
