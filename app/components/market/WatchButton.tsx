"use client";

/**
 * Add/remove a market from the watchlist.
 *
 * RENDERS AS A SPAN, NOT A BUTTON, because the markets-table call site sits
 * inside a row that is itself a `<Link>`, and a `<button>` inside an `<a>` is
 * invalid HTML that browsers recover from unpredictably. `role="button"` plus
 * explicit key handling keeps it operable while staying a legal descendant,
 * and the handler stops propagation AND prevents default so watching a market
 * never also navigates away from the page being scanned. Both are load-bearing
 * there: `stopPropagation` blocks next/link's React onClick, `preventDefault`
 * cancels the anchor's native activation.
 *
 * (The trade-page call site is NOT inside a link — it is a flex child of the
 * info bar. The span costs nothing there and keeps one implementation.)
 *
 * Styled off the row badges already on the markets table — square, hairline
 * border, uppercase — but sized as a CONTROL, not a badge: those badges are
 * not interactive, and copying their ~16px box straight across would have
 * shipped a tap target well under the 24px floor, inside a full-row link where
 * a near-miss navigates instead. The repo's own interactive controls carry
 * min-h-[32px]/[36px]/[40px]; this takes the smallest that still clears the
 * floor in a dense table row.
 *
 * Colour comes from --accent-text, not --accent: globals.css documents that
 * plain --accent tops out near 4.3:1, under the 4.5:1 AA floor for small text,
 * and provides --accent-text (5.6:1 / 6.0:1) for exactly this.
 */

import { FC, useCallback } from "react";
import { useWatchlist } from "@/hooks/useWatchlist";

interface WatchButtonProps {
  slab: string;
  /** Named in the accessible name so the control says WHICH market it affects. */
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
  const { isWatched, toggle, full, max } = useWatchlist();
  const watched = isWatched(slab);
  // Being full must never block REMOVING, or a full list is a dead end.
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
  const hint = blocked
    ? `Watchlist is full (${max}) — remove a market first`
    : watched
      ? `Remove ${name} from your watchlist`
      : `Add ${name} to your watchlist`;

  return (
    <span
      role="button"
      // Focusable even when blocked. aria-disabled exists precisely to keep the
      // element reachable so the reason can be announced; pairing it with
      // tabIndex={-1} would give the drawback of `disabled` with none of the
      // explanation, and at the cap that is the moment it has most to say.
      tabIndex={0}
      aria-pressed={watched}
      aria-disabled={blocked || undefined}
      // STATIC name + aria-pressed for state. A name that flips to "Remove …"
      // while aria-pressed reports "pressed" double-negates: the name says the
      // action, the state says the opposite. On the label variant there is
      // visible text, so no aria-label at all — overriding it would break
      // WCAG 2.5.3 Label in Name and stop voice control activating it.
      aria-label={variant === "icon" ? `Watch ${name}` : undefined}
      title={hint}
      onClick={activate}
      onKeyDown={(e) => {
        // Native buttons activate Space on keyup and never auto-repeat. Without
        // the repeat guard, holding Space toggles at the key-repeat rate and
        // writes localStorage on every tick.
        if (e.repeat) return;
        if (e.key === "Enter" || e.key === " ") activate(e);
      }}
      className={[
        "inline-flex shrink-0 select-none items-center justify-center border text-[9px] font-medium uppercase tracking-wider transition-colors",
        variant === "icon"
          ? "min-h-[24px] min-w-[24px] px-1"
          : "min-h-[24px] px-2",
        blocked
          ? "cursor-not-allowed border-[var(--border)] text-[var(--text-dim)]"
          : watched
            ? "cursor-pointer border-[var(--accent-text)]/50 bg-[var(--accent-text)]/10 text-[var(--accent-text)] hover:bg-[var(--accent-text)]/20"
            : "cursor-pointer border-[var(--text-secondary)]/40 text-[var(--text-secondary)] hover:border-[var(--accent-text)] hover:text-[var(--accent-text)]",
        className,
      ].join(" ")}
    >
      {variant === "icon"
        ? (watched ? "★" : "☆")
        : (watched ? "★ watching" : "☆ watch")}
    </span>
  );
};
