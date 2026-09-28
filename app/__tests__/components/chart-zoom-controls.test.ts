import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { computeZoomedRange } from "@/components/trade/ChartZoomControls";

describe("computeZoomedRange — center-preserving, clamped chart zoom", () => {
  const range = { from: 100, to: 200 }; // span 100, center 150

  it("zoom in shrinks the span around the same center", () => {
    const z = computeZoomedRange(range, "in");
    expect((z.from + z.to) / 2).toBeCloseTo(150); // center preserved
    expect(z.to - z.from).toBeLessThan(100); // smaller span (zoomed in)
    expect(z.to - z.from).toBeGreaterThan(0);
  });

  it("zoom out grows the span around the same center", () => {
    const z = computeZoomedRange(range, "out");
    expect((z.from + z.to) / 2).toBeCloseTo(150);
    expect(z.to - z.from).toBeGreaterThan(100); // larger span (zoomed out)
  });

  it("in then out round-trips back to the original span and center", () => {
    const back = computeZoomedRange(computeZoomedRange(range, "in"), "out");
    expect(back.to - back.from).toBeCloseTo(100);
    expect((back.from + back.to) / 2).toBeCloseTo(150);
  });

  it("clamps a zoom-in so the view can't collapse below ~6 bars", () => {
    let z = { from: 0, to: 8 };
    for (let i = 0; i < 20; i++) z = computeZoomedRange(z, "in");
    expect(z.to - z.from).toBeGreaterThanOrEqual(6); // 2 * MIN_HALF_SPAN(3)
    expect((z.from + z.to) / 2).toBeCloseTo(4); // still centered
  });
});

describe("ChartZoomControls wiring", () => {
  // Source-bind the UI: it must use the center-based logical-range zoom (not the
  // naive barSpacing snap), call fitContent for reset, and expose three labelled
  // controls. A render test would need a live lightweight-charts instance.
  const SRC = fs.readFileSync(
    path.resolve(__dirname, "../../components/trade/ChartZoomControls.tsx"),
    "utf8",
  );
  it("zooms via the visible logical range and resets via fitContent", () => {
    expect(SRC).toContain("getVisibleLogicalRange()");
    expect(SRC).toContain("setVisibleLogicalRange(computeZoomedRange(range, kind))");
    expect(SRC).toContain("ts.fitContent()");
  });
  it("exposes zoom-in, zoom-out and fit controls with accessible labels", () => {
    expect(SRC).toContain('aria-label="Zoom in"');
    expect(SRC).toContain('aria-label="Zoom out"');
    expect(SRC).toContain('aria-label="Fit all data"');
  });
});
