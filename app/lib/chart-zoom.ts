/**
 * Pure zoom math for the trading chart's zoom controls (+ / − / reset)
 * and click-and-drag box-zoom (GH: "add zoom in zoom out buttons on
 * charts plus click and drag to zoom in and out").
 *
 * Deliberately dependency-free from `lightweight-charts` and React so it
 * can be unit-tested in isolation and reused by `useChartZoomControls`
 * (the hook that wires this math to an actual chart instance) — and by
 * any future chart that wants the same zoom behaviour, per the "small
 * shared hook/component so behaviour is consistent" requirement.
 */

/** A lightweight-charts logical range: [from, to] in bar-index space.
 *  Mirrors `LogicalRange` from `lightweight-charts` structurally without
 *  importing the library here — a logical range is just two numbers. */
export interface LogicalRange {
  from: number;
  to: number;
}

/** Each zoom-in click narrows the visible range to 70% of its current
 *  width; zoom-out is the exact inverse, so N zoom-ins followed by N
 *  zoom-outs return (modulo the min-bars/extent clamps) to the
 *  starting width. */
export const ZOOM_IN_FACTOR = 0.7;
export const ZOOM_OUT_FACTOR = 1 / ZOOM_IN_FACTOR;

/** Never let a zoom-in click narrow the visible range below this many
 *  bars — past this a candle chart stops being readable (bars start
 *  overlapping, the crosshair can't distinguish neighbours). Also the
 *  floor a box-zoom drag widens up to when the dragged box is thinner
 *  than this many bars (treats a near-click-width drag as "zoom to
 *  roughly here" instead of an unreadable sliver). */
export const DEFAULT_MIN_VISIBLE_BARS = 5;

export interface ScaleRangeOptions {
  /** Floor on the resulting range width, in bars. Defaults to
   *  DEFAULT_MIN_VISIBLE_BARS. Pass 0 to disable the floor. */
  minBars?: number;
  /** Data extent (first/last loaded bar's logical index), e.g.
   *  `{ dataFrom: 0, dataTo: barCount - 1 }`. When given, the resulting
   *  range's width is capped to the extent's width — zooming out never
   *  goes past "all loaded data" — and the window is shifted (not
   *  clipped) back inside the extent if scaling around the center would
   *  push either edge past it. Omit either bound to skip the extent
   *  clamp (e.g. extent not known yet). */
  dataFrom?: number;
  dataTo?: number;
}

/** Scale a logical range around its own center by `factor`
 *  (< 1 narrows the range / zooms in, > 1 widens it / zooms out),
 *  clamped to `opts.minBars` and, when given, `[opts.dataFrom,
 *  opts.dataTo]`.
 *
 *  Degenerate/non-finite input (non-positive factor, a zero-or-negative-
 *  width range, non-finite bounds) returns the input range unchanged
 *  rather than producing NaN/Infinity — callers feed the result straight
 *  into lightweight-charts' `setVisibleLogicalRange`, which throws on a
 *  non-finite range. */
export function scaleLogicalRange(
  range: LogicalRange,
  factor: number,
  opts: ScaleRangeOptions = {},
): LogicalRange {
  if (
    !Number.isFinite(range.from) ||
    !Number.isFinite(range.to) ||
    !Number.isFinite(factor) ||
    factor <= 0
  ) {
    return range;
  }
  const width = range.to - range.from;
  if (!(width > 0)) return range;

  const center = (range.from + range.to) / 2;
  const minBars = opts.minBars ?? DEFAULT_MIN_VISIBLE_BARS;

  let newWidth = width * factor;
  if (minBars > 0 && newWidth < minBars) newWidth = minBars;

  const hasExtent =
    opts.dataFrom != null &&
    opts.dataTo != null &&
    Number.isFinite(opts.dataFrom) &&
    Number.isFinite(opts.dataTo) &&
    opts.dataTo > opts.dataFrom;
  if (hasExtent) {
    const extentWidth = opts.dataTo! - opts.dataFrom!;
    if (newWidth > extentWidth) newWidth = extentWidth;
  }

  let from = center - newWidth / 2;
  let to = center + newWidth / 2;

  if (hasExtent) {
    // Shift the whole window back inside the extent rather than clipping
    // one edge — clipping would silently shrink newWidth below what we
    // just computed (and re-trigger the min-bars floor asymmetrically).
    if (from < opts.dataFrom!) {
      const shift = opts.dataFrom! - from;
      from += shift;
      to += shift;
    }
    if (to > opts.dataTo!) {
      const shift = to - opts.dataTo!;
      from -= shift;
      to -= shift;
    }
  }

  return { from, to };
}

/** Zoom in: narrow the range to 70% of its width, centered. */
export function zoomInRange(range: LogicalRange, opts?: ScaleRangeOptions): LogicalRange {
  return scaleLogicalRange(range, ZOOM_IN_FACTOR, opts);
}

/** Zoom out: widen the range to 1/0.7 of its width, centered. */
export function zoomOutRange(range: LogicalRange, opts?: ScaleRangeOptions): LogicalRange {
  return scaleLogicalRange(range, ZOOM_OUT_FACTOR, opts);
}

export interface PixelsToLogicalRangeOptions {
  /** Floor on the resulting range width, in bars — see scaleLogicalRange.
   *  Defaults to DEFAULT_MIN_VISIBLE_BARS. */
  minBars?: number;
}

/** Convert a horizontal pixel drag (x1 -> x2) into a logical range, via
 *  the chart-supplied `coordinateToLogical` projector (injected as a
 *  plain function — `IChartApi["timeScale"]()["coordinateToLogical"]` —
 *  rather than importing `lightweight-charts`, so this stays pure and
 *  unit-testable with a trivial mock).
 *
 *  Returns null when either edge doesn't project onto the chart (no
 *  data loaded yet). Orders the result (from <= to) regardless of drag
 *  direction — a right-to-left drag is just as valid as left-to-right —
 *  and widens a too-thin drag box up to `minBars` around its center so
 *  a near-click-width drag doesn't zoom to a single unreadable bar. */
export function pixelsToLogicalRange(
  x1: number,
  x2: number,
  coordinateToLogical: (x: number) => number | null,
  opts: PixelsToLogicalRangeOptions = {},
): LogicalRange | null {
  const l1 = coordinateToLogical(x1);
  const l2 = coordinateToLogical(x2);
  if (l1 == null || l2 == null || !Number.isFinite(l1) || !Number.isFinite(l2)) {
    return null;
  }

  let from = Math.min(l1, l2);
  let to = Math.max(l1, l2);
  const minBars = opts.minBars ?? DEFAULT_MIN_VISIBLE_BARS;
  if (minBars > 0 && to - from < minBars) {
    const center = (from + to) / 2;
    from = center - minBars / 2;
    to = center + minBars / 2;
  }
  return { from, to };
}
