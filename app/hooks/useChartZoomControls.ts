"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { IChartApi } from "lightweight-charts";
import {
  scaleLogicalRange,
  pixelsToLogicalRange,
  ZOOM_IN_FACTOR,
  ZOOM_OUT_FACTOR,
  DEFAULT_MIN_VISIBLE_BARS,
} from "@/lib/chart-zoom";

/** In-progress box-zoom drag, in CSS px relative to the chart container —
 *  drives the translucent selection rectangle overlay while dragging. */
export interface ChartDragSelection {
  left: number;
  width: number;
}

export interface UseChartZoomControlsOptions {
  /** Live chart API ref managed by the parent's chart-init effect. May
   *  be null briefly between mount and chart creation — same contract
   *  as ChartDrawingOverlay's chartRef prop. */
  chartRef: RefObject<IChartApi | null>;
  /** Flips true once the chart-init effect has populated chartRef. */
  chartReady: boolean;
  /** Total bars currently loaded for the active series. Used only to
   *  clamp zoom-OUT so the − button (and box-zoom, indirectly via
   *  setVisibleLogicalRange's own clamping) never widens past "all
   *  loaded data" — read through a ref internally so this doesn't need
   *  to be a stable reference. 0/negative disables the extent clamp
   *  (falls back to the minBars floor alone). */
  barCount: number;
  /** Floor on the visible range width, in bars. Defaults to
   *  DEFAULT_MIN_VISIBLE_BARS. */
  minBars?: number;
  /** Box-zoom-drag and double-click-reset are suppressed unless this is
   *  true — the caller passes `drawingTool === "pointer"` so these
   *  gestures don't fight ChartDrawingOverlay's own click/drag handling
   *  (trend/horizontal/rectangle creation) on the same chart element. */
  isPointerTool: boolean;
  /** Suppresses box-zoom-drag + double-click-reset entirely, e.g. while
   *  the empty-state overlay covers the chart (nothing meaningful to
   *  zoom to yet). Zoom-in/out/reset buttons stay callable regardless —
   *  they're harmless no-ops when the chart has no data
   *  (getVisibleLogicalRange() returns null). */
  enabled: boolean;
}

export interface UseChartZoomControlsResult {
  /** Narrow the visible logical range to 70% of its width, centered. */
  zoomIn: () => void;
  /** Widen the visible logical range to 1/0.7 of its width, centered,
   *  clamped to the loaded data extent. */
  zoomOut: () => void;
  /** Reset to the default fit-all-data view (`timeScale().fitContent()`). */
  reset: () => void;
  /** Whether drag currently box-zooms (true) or pans (false, the
   *  lightweight-charts default). */
  dragToZoom: boolean;
  setDragToZoom: (next: boolean) => void;
  /** Non-null exactly while a box-zoom drag is in progress. */
  dragSelection: ChartDragSelection | null;
}

/** Minimum drag distance (CSS px) before a mousedown+mouseup is treated
 *  as a box-zoom drag rather than a plain click — mirrors the 10px
 *  jitter guard ChartDrawingOverlay's rectangle tool uses for the same
 *  reason (a click shouldn't zoom to some unreadable sliver). */
const MIN_DRAG_PX = 10;

/**
 * Wires the pure zoom math in `lib/chart-zoom.ts` to a live lightweight-
 * charts instance: the +/−/reset button actions, a "drag to zoom" mode
 * toggle (box-zoom-drag replacing the default pan-on-drag), and
 * double-click-to-reset. Kept as a single hook (rather than splitting
 * button actions from drag handling) so `TradingChart` has one place to
 * wire up and any other lightweight-charts price/candle chart in the
 * app can reuse the exact same behaviour.
 *
 * Deliberately does NOT touch `chart.options().handleScroll` /
 * `handleScale` except for the duration of an active box-zoom drag
 * (snapshotted and restored exactly like ChartDrawingOverlay's rectangle
 * tool) — mouse-wheel zoom, pinch, and axis-drag-scale stay live the
 * entire time, per spec.
 */
export function useChartZoomControls({
  chartRef,
  chartReady,
  barCount,
  minBars = DEFAULT_MIN_VISIBLE_BARS,
  isPointerTool,
  enabled,
}: UseChartZoomControlsOptions): UseChartZoomControlsResult {
  const [dragToZoom, setDragToZoom] = useState(false);
  const [dragSelection, setDragSelection] = useState<ChartDragSelection | null>(null);

  // Read through refs inside imperative handlers/effects below so none
  // of them need to be effect dependencies — same pattern as
  // chartThemeRef / loadOlderExternalRef in TradingChart.
  const barCountRef = useRef(barCount);
  barCountRef.current = barCount;
  const minBarsRef = useRef(minBars);
  minBarsRef.current = minBars;

  const applyScale = useCallback(
    (factor: number) => {
      const chart = chartRef.current;
      if (!chart) return;
      const ts = chart.timeScale();
      const current = ts.getVisibleLogicalRange();
      if (!current) return;
      const count = barCountRef.current;
      const hasExtent = count > 0;
      const next = scaleLogicalRange(current, factor, {
        minBars: minBarsRef.current,
        dataFrom: hasExtent ? 0 : undefined,
        dataTo: hasExtent ? count - 1 : undefined,
      });
      ts.setVisibleLogicalRange(next);
    },
    [chartRef],
  );

  const zoomIn = useCallback(() => applyScale(ZOOM_IN_FACTOR), [applyScale]);
  const zoomOut = useCallback(() => applyScale(ZOOM_OUT_FACTOR), [applyScale]);

  const reset = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().fitContent();
  }, [chartRef]);

  // Keyboard +/- when the chart is focused (nice-to-have). The chart's
  // generated element has no tabIndex by default, so it's never a
  // keyboard target — give it one so a click (which focuses any element
  // with a tabIndex) or Tab navigation can reach it.
  useEffect(() => {
    if (!chartReady) return;
    const chart = chartRef.current;
    if (!chart) return;
    const el = chart.chartElement();
    const hadTabIndex = el.hasAttribute("tabindex");
    if (!hadTabIndex) el.tabIndex = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("keydown", onKeyDown);
      if (!hadTabIndex) el.removeAttribute("tabindex");
    };
  }, [chartReady, chartRef, zoomIn, zoomOut]);

  // Double-click anywhere on the chart resets zoom to fitContent().
  // Gated on isPointerTool so it doesn't fire mid-drawing-creation (a
  // double-click could otherwise land as two trend-tool clicks).
  useEffect(() => {
    if (!chartReady || !enabled || !isPointerTool) return;
    const chart = chartRef.current;
    if (!chart) return;
    const el = chart.chartElement();
    const onDblClick = (): void => reset();
    el.addEventListener("dblclick", onDblClick);
    return () => el.removeEventListener("dblclick", onDblClick);
  }, [chartReady, enabled, isPointerTool, chartRef, reset]);

  // Box-zoom drag: only attached while dragToZoom is on, the pointer
  // tool is active (not mid-drawing-creation), and the chart has
  // something to zoom to. Mirrors ChartDrawingOverlay's rectangle-drag
  // wiring (chartElement() mousedown -> document mousemove/mouseup,
  // rAF-coalesced preview, scroll/scale suppressed for the drag's
  // duration, stuck-state recovery on blur/contextmenu).
  useEffect(() => {
    if (!chartReady || !enabled || !dragToZoom || !isPointerTool) return;
    const chart = chartRef.current;
    if (!chart) return;
    const el = chart.chartElement();

    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      const startX = e.clientX - rect.left;

      const previousScroll = chart.options().handleScroll;
      const previousScale = chart.options().handleScale;
      try {
        chart.applyOptions({ handleScroll: false, handleScale: false });
      } catch {
        // Chart torn down between mousedown and applyOptions; the
        // matching restore below is symmetrically guarded.
      }

      setDragSelection({ left: startX, width: 0 });

      let rafScheduled = false;
      let rafId = 0;
      let pendingClientX: number | null = null;

      const flush = (): void => {
        rafScheduled = false;
        rafId = 0;
        if (pendingClientX === null) return;
        const currentRect = el.getBoundingClientRect();
        const currentX = pendingClientX - currentRect.left;
        pendingClientX = null;
        setDragSelection({
          left: Math.min(startX, currentX),
          width: Math.abs(currentX - startX),
        });
      };

      const onMouseMove = (moveEvent: MouseEvent): void => {
        pendingClientX = moveEvent.clientX;
        if (!rafScheduled) {
          rafScheduled = true;
          rafId = window.requestAnimationFrame(flush);
        }
      };

      const finish = (endClientX: number | null): void => {
        if (rafScheduled) {
          window.cancelAnimationFrame(rafId);
          rafScheduled = false;
          rafId = 0;
        }
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.removeEventListener("contextmenu", onContextMenu);
        window.removeEventListener("blur", onWindowBlur);
        try {
          chart.applyOptions({ handleScroll: previousScroll, handleScale: previousScale });
        } catch {
          // Chart destroyed mid-drag; nothing to restore.
        }
        setDragSelection(null);

        if (endClientX === null) return; // cancelled (blur/contextmenu)
        const endRect = el.getBoundingClientRect();
        const endX = endClientX - endRect.left;
        if (Math.abs(endX - startX) < MIN_DRAG_PX) return; // click, not a drag
        const ts = chart.timeScale();
        const range = pixelsToLogicalRange(
          startX,
          endX,
          (x) => ts.coordinateToLogical(x),
          { minBars: minBarsRef.current },
        );
        if (range) ts.setVisibleLogicalRange(range);
      };

      const onMouseUp = (upEvent: MouseEvent): void => finish(upEvent.clientX);
      const onContextMenu = (): void => finish(null);
      const onWindowBlur = (): void => finish(null);

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.addEventListener("contextmenu", onContextMenu);
      window.addEventListener("blur", onWindowBlur);
    };

    el.addEventListener("mousedown", onMouseDown);
    return () => el.removeEventListener("mousedown", onMouseDown);
  }, [chartReady, enabled, dragToZoom, isPointerTool, chartRef]);

  return { zoomIn, zoomOut, reset, dragToZoom, setDragToZoom, dragSelection };
}
