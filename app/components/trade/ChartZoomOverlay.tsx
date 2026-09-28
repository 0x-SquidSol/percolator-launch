"use client";

import type { FC } from "react";
import type { ChartDragSelection } from "@/hooks/useChartZoomControls";

interface ChartZoomOverlayProps {
  /** Non-null while a box-zoom drag is in progress; null hides the
   *  overlay entirely (rendering nothing, not just an invisible div). */
  selection: ChartDragSelection | null;
}

/**
 * Translucent selection rectangle shown while the user drags to box-zoom
 * (see `useChartZoomControls`, which owns the drag state and actually
 * performs the zoom on release — this component only paints the
 * in-progress selection).
 *
 * `pointer-events-none` — same contract as ChartDrawingOverlay: this
 * overlay never captures pointer events. The drag itself is driven by
 * native listeners the hook attaches directly to
 * `chart.chartElement()`, which sits underneath (and keeps receiving
 * events through) this div.
 *
 * Full chart height (`inset-y-0`), spans only the dragged width — a
 * vertical time-range band, not a price-bounded box, since box-zoom
 * here only adjusts the visible logical (time) range.
 */
export const ChartZoomOverlay: FC<ChartZoomOverlayProps> = ({ selection }) => {
  if (!selection) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 z-[1] border-x border-[var(--accent)]/60"
      style={{
        left: selection.left,
        width: selection.width,
        background: "color-mix(in srgb, var(--accent) 15%, transparent)",
      }}
    />
  );
};
