"use client";

import { useCallback } from "react";
import type { IChartApi } from "lightweight-charts";

/**
 * On-screen chart zoom controls (+ / − / fit), matching the standard trading-chart
 * toolbar (TradingView / Binance / Bybit).
 *
 * lightweight-charts already handles the pro gestures — mouse-wheel zoom,
 * drag-to-pan, axis-drag scale, and pinch — but exposes NO on-screen buttons, so
 * trackpad users and anyone who doesn't know about wheel-zoom had no visible way
 * to zoom. These buttons close that gap without touching the native interactions.
 *
 * Zoom is done on the time scale's VISIBLE LOGICAL RANGE, scaled around the range's
 * CENTER — so a click keeps whatever you're currently looking at centered, whether
 * you're at the present or scrolled back in history (anchoring to the latest bar,
 * the naive barSpacing approach, would jump you to the present on every click).
 * "Fit" calls fitContent() to reset to all data — the standard reset control.
 */

/** Per-click zoom ratio. 1.6 ≈ a noticeable but not jarring step. */
const ZOOM_STEP = 1.6;
/** Don't let a zoom-in shrink the view below ~6 visible bars. */
const MIN_HALF_SPAN = 3;

/**
 * The next visible logical range for a zoom step, scaled around the current
 * range's CENTER (so the user's focus point stays put) and clamped so a zoom-in
 * can't shrink below ~6 visible bars. Exported pure so the math is unit-tested
 * without a chart instance.
 */
export function computeZoomedRange(
  range: { from: number; to: number },
  kind: "in" | "out",
): { from: number; to: number } {
  const center = (range.from + range.to) / 2;
  // in → shrink the span (fewer bars, closer); out → grow it.
  const factor = kind === "in" ? 1 / ZOOM_STEP : ZOOM_STEP;
  const halfSpan = Math.max(MIN_HALF_SPAN, ((range.to - range.from) / 2) * factor);
  return { from: center - halfSpan, to: center + halfSpan };
}

export function ChartZoomControls({
  chartRef,
}: {
  chartRef: React.RefObject<IChartApi | null>;
}) {
  const apply = useCallback(
    (kind: "in" | "out" | "fit") => {
      const chart = chartRef.current;
      if (!chart) return;
      const ts = chart.timeScale();

      if (kind === "fit") {
        ts.fitContent();
        return;
      }

      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      ts.setVisibleLogicalRange(computeZoomedRange(range, kind));
    },
    [chartRef],
  );

  const btn =
    "flex h-7 w-7 items-center justify-center border border-[var(--border)]/60 " +
    "bg-[var(--bg)]/85 text-[15px] font-bold leading-none text-[var(--text-secondary)] " +
    "backdrop-blur-sm transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--text)] " +
    "focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]/60";

  return (
    <div
      className="absolute bottom-8 left-2 z-10 flex select-none touch-none flex-col gap-1"
      role="group"
      aria-label="Chart zoom"
    >
      <button type="button" onClick={() => apply("in")} className={btn} aria-label="Zoom in" title="Zoom in">
        +
      </button>
      <button type="button" onClick={() => apply("out")} className={btn} aria-label="Zoom out" title="Zoom out">
        −
      </button>
      <button
        type="button"
        onClick={() => apply("fit")}
        className={`${btn} text-[12px]`}
        aria-label="Fit all data"
        title="Fit all data"
      >
        ⤢
      </button>
    </div>
  );
}
