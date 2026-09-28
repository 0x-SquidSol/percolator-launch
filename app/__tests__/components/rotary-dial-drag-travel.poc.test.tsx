/**
 * PoC — the Control Room dials travel half the distance their own constant
 * documents, and the per-notch feel is a function of the caller's range.
 *
 * This file ASSERTS THE BUGGY BEHAVIOUR and passes on current `playground`. It
 * is the evidence for the issue, not the fix; the regression test that replaces
 * it asserts the corrected numbers.
 *
 * Drags are driven ONE PIXEL PER EVENT, which is the whole point. The handler
 * accumulates into a ref across mousemove events, so a single large mousemove
 * is a teleport that exercises none of the accumulation — and therefore cannot
 * see this defect at all. My first attempt at this test made exactly that
 * mistake.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RotaryDial } from "@/components/create/RotaryDial";

/** What RotaryDial.tsx:26-27 claims: "Vertical pixels of drag for a full min→max sweep." */
const DOCUMENTED_SWEEP_PX = 190;

/** The three real call sites — StepControlRoom.tsx:146-181. */
const DIALS = {
  leverage: { label: "Leverage", min: 2, max: 10, step: 0.5 },
  liquidity: { label: "Liquidity", min: 100, max: 10_000, step: 100 },
  insurance: { label: "Insurance", min: 100, max: 1_000, step: 25 },
} as const;

type Dial = (typeof DIALS)[keyof typeof DIALS];

/**
 * Drags upward one pixel at a time until the dial reaches `max`, and returns
 * how many pixels that took. A controlled component re-render is simulated by
 * re-rendering with each committed value, exactly as StepControlRoom does.
 */
function pixelsForFullSweep(dial: Dial, limitPx = 4000): number {
  // Unmount anything a previous sweep left behind. Two dials can share a
  // label, and every mounted instance keeps its own window mousemove
  // listener, so leaking them makes the harness ambiguous.
  cleanup();
  let value: number = dial.min;
  const onChange = vi.fn((v: number) => {
    value = v;
  });

  const { rerender } = render(
    <RotaryDial {...dial} value={value} format={String} onChange={onChange} />,
  );
  const knob = screen.getByRole("slider", { name: dial.label });

  let y = 2000;
  fireEvent.mouseDown(knob, { clientY: y });

  let px = 0;
  while (value < dial.max && px < limitPx) {
    y -= 1; // up = increase
    fireEvent.mouseMove(window, { clientY: y });
    px += 1;
    // The parent owns the value; feed it back so the handler sees the new one.
    rerender(<RotaryDial {...dial} value={value} format={String} onChange={onChange} />);
  }
  fireEvent.mouseUp(window);
  return px;
}

describe("PoC: a full dial sweep costs half its documented travel", () => {
  it("CONTROL: the dial mounts and exposes a slider to drag", () => {
    // Everything below counts pixels until a value changes. If the knob were
    // missing or inert the loop would simply hit its limit, so this pins the
    // premise: the control exists and is reachable by its label.
    render(<RotaryDial {...DIALS.leverage} value={4} format={String} onChange={vi.fn()} />);
    expect(screen.getByRole("slider", { name: "Leverage" })).toBeTruthy();
  });

  it("Leverage 2→10 sweeps in ~96px, not the documented 190px", () => {
    const px = pixelsForFullSweep(DIALS.leverage);
    // The defect: roughly half. Asserted as a band so this is about the 2x
    // factor and not about an exact pixel count.
    expect(px).toBeGreaterThan(80);
    expect(px).toBeLessThan(115);
    expect(px).toBeLessThan(DOCUMENTED_SWEEP_PX * 0.65);
  });

  it("Liquidity 100→10,000 sweeps in ~99px — one pixel per 100 sim-USDC", () => {
    const px = pixelsForFullSweep(DIALS.liquidity);
    expect(px).toBeLessThan(DOCUMENTED_SWEEP_PX * 0.65);
    const detents = (DIALS.liquidity.max - DIALS.liquidity.min) / DIALS.liquidity.step;
    // ~1.0. A single pixel of mouse movement moves the LP seed by a full step,
    // so there is no gesture that lands on a chosen value.
    expect(px / detents).toBeLessThan(1.5);
  });

  it("Insurance 100→1,000 sweeps in ~108px", () => {
    const px = pixelsForFullSweep(DIALS.insurance);
    expect(px).toBeLessThan(DOCUMENTED_SWEEP_PX * 0.65);
  });

  it("the per-notch feel differs ~6x between dials on the same panel", () => {
    // This is the part a user feels. The same gesture on three dials sitting in
    // one grid produces wildly different results, because the travel budget is
    // spent per DIAL while the notches are owned by the CALLER.
    const perDetent = (d: Dial) => pixelsForFullSweep(d) / ((d.max - d.min) / d.step);
    const lev = perDetent(DIALS.leverage);
    const liq = perDetent(DIALS.liquidity);
    expect(lev / liq).toBeGreaterThan(4);
  });
});
