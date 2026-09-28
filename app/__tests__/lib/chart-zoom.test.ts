import { describe, it, expect } from "vitest";
import {
  scaleLogicalRange,
  zoomInRange,
  zoomOutRange,
  pixelsToLogicalRange,
  ZOOM_IN_FACTOR,
  ZOOM_OUT_FACTOR,
  DEFAULT_MIN_VISIBLE_BARS,
  type LogicalRange,
} from "../../lib/chart-zoom";

describe("scaleLogicalRange", () => {
  it("narrows a range around its center for factor < 1 (zoom in)", () => {
    const range: LogicalRange = { from: 0, to: 100 };
    const result = scaleLogicalRange(range, 0.5, { minBars: 1 });
    // Center stays at 50; width halves to 50 -> [25, 75]
    expect(result).toEqual({ from: 25, to: 75 });
  });

  it("widens a range around its center for factor > 1 (zoom out)", () => {
    const range: LogicalRange = { from: 40, to: 60 }; // center 50, width 20
    const result = scaleLogicalRange(range, 2, { minBars: 1 });
    expect(result).toEqual({ from: 30, to: 70 });
  });

  it("zoomInRange narrows to exactly ZOOM_IN_FACTOR of the width", () => {
    const range: LogicalRange = { from: 0, to: 100 };
    const result = zoomInRange(range, { minBars: 1 });
    const width = result.to - result.from;
    expect(width).toBeCloseTo(100 * ZOOM_IN_FACTOR, 10);
    // Still centered on 50
    expect((result.from + result.to) / 2).toBeCloseTo(50, 10);
  });

  it("zoomOutRange widens to exactly ZOOM_OUT_FACTOR of the width", () => {
    const range: LogicalRange = { from: 0, to: 100 };
    const result = zoomOutRange(range, { minBars: 1 });
    const width = result.to - result.from;
    expect(width).toBeCloseTo(100 * ZOOM_OUT_FACTOR, 10);
  });

  it("zoomInRange then zoomOutRange round-trips back to the original width", () => {
    const range: LogicalRange = { from: 10, to: 110 }; // width 100
    const zoomed = zoomInRange(range, { minBars: 1 });
    const restored = zoomOutRange(zoomed, { minBars: 1 });
    expect(restored.to - restored.from).toBeCloseTo(100, 8);
    expect((restored.from + restored.to) / 2).toBeCloseTo(60, 8);
  });

  it("clamps the result width to the minBars floor when zooming in past it", () => {
    const range: LogicalRange = { from: 0, to: 10 }; // width 10
    // Zooming in repeatedly with a small factor would go below minBars.
    const result = scaleLogicalRange(range, 0.1, { minBars: 5 });
    expect(result.to - result.from).toBe(5);
    // Still centered on the original center (5)
    expect((result.from + result.to) / 2).toBeCloseTo(5, 10);
  });

  it("defaults the minBars floor to DEFAULT_MIN_VISIBLE_BARS when not given", () => {
    const range: LogicalRange = { from: 0, to: 10 };
    const result = scaleLogicalRange(range, 0.01);
    expect(result.to - result.from).toBe(DEFAULT_MIN_VISIBLE_BARS);
  });

  it("clamps zoom-out width to the data extent instead of expanding past it", () => {
    const range: LogicalRange = { from: 40, to: 60 }; // width 20, center 50
    const result = scaleLogicalRange(range, 100, { minBars: 1, dataFrom: 0, dataTo: 100 });
    // Would want width 2000; capped to the extent width (100).
    expect(result.to - result.from).toBe(100);
    expect(result.from).toBe(0);
    expect(result.to).toBe(100);
  });

  it("shifts (not clips) the window back inside the extent when centered scaling would overflow the left edge", () => {
    const range: LogicalRange = { from: 0, to: 20 }; // center 10, width 20
    const result = scaleLogicalRange(range, 2, { minBars: 1, dataFrom: 0, dataTo: 200 });
    // Naive centered scale would give [-10, 30]; shifted right by 10 to [0, 40].
    expect(result.to - result.from).toBe(40);
    expect(result.from).toBe(0);
    expect(result.to).toBe(40);
  });

  it("shifts the window back inside the extent when centered scaling would overflow the right edge", () => {
    const range: LogicalRange = { from: 180, to: 200 }; // center 190, width 20
    const result = scaleLogicalRange(range, 2, { minBars: 1, dataFrom: 0, dataTo: 200 });
    // Naive centered scale would give [170, 210]; shifted left by 10 to [160, 200].
    expect(result.to - result.from).toBe(40);
    expect(result.to).toBe(200);
    expect(result.from).toBe(160);
  });

  it("returns the input unchanged for a non-positive factor", () => {
    const range: LogicalRange = { from: 0, to: 100 };
    expect(scaleLogicalRange(range, 0)).toEqual(range);
    expect(scaleLogicalRange(range, -1)).toEqual(range);
  });

  it("returns the input unchanged for non-finite bounds", () => {
    const range: LogicalRange = { from: NaN, to: 100 };
    expect(scaleLogicalRange(range, 0.5)).toEqual(range);
  });

  it("returns the input unchanged for a zero-or-negative-width range", () => {
    const flat: LogicalRange = { from: 50, to: 50 };
    expect(scaleLogicalRange(flat, 0.5)).toEqual(flat);
    const inverted: LogicalRange = { from: 50, to: 10 };
    expect(scaleLogicalRange(inverted, 0.5)).toEqual(inverted);
  });
});

describe("pixelsToLogicalRange", () => {
  // Simple linear projector: 10 px per bar, bar 0 at x=0.
  const linearProjector = (x: number): number | null => x / 10;

  it("converts a left-to-right pixel drag into an ordered logical range", () => {
    const result = pixelsToLogicalRange(0, 200, linearProjector, { minBars: 1 });
    expect(result).toEqual({ from: 0, to: 20 });
  });

  it("orders the range correctly for a right-to-left drag", () => {
    const result = pixelsToLogicalRange(200, 0, linearProjector, { minBars: 1 });
    expect(result).toEqual({ from: 0, to: 20 });
  });

  it("widens a too-thin drag box up to minBars, centered on the drag", () => {
    // Drag spans x=100..101 -> logical 10..10.1, width 0.1 bars.
    const result = pixelsToLogicalRange(100, 101, linearProjector, { minBars: 5 });
    expect(result).not.toBeNull();
    const width = result!.to - result!.from;
    expect(width).toBe(5);
    // Centered on the drag's own center (~10.05)
    expect((result!.from + result!.to) / 2).toBeCloseTo(10.05, 5);
  });

  it("returns null when either edge fails to project (no data loaded)", () => {
    const nullProjector = (): number | null => null;
    expect(pixelsToLogicalRange(0, 100, nullProjector)).toBeNull();
  });

  it("returns null when only one edge fails to project", () => {
    const halfNullProjector = (x: number): number | null => (x === 0 ? null : x / 10);
    expect(pixelsToLogicalRange(0, 100, halfNullProjector)).toBeNull();
  });

  it("defaults minBars to DEFAULT_MIN_VISIBLE_BARS", () => {
    const result = pixelsToLogicalRange(100, 100.5, linearProjector);
    expect(result!.to - result!.from).toBe(DEFAULT_MIN_VISIBLE_BARS);
  });
});
