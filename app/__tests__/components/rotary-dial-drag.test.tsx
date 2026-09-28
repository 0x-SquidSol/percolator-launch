/**
 * Regression test — RotaryDial pointer-drag travel and stop behaviour (GH#2648).
 *
 * Guards two defects in the drag handler:
 *
 *   (A) the rounding remainder was discarded on commit (`residue.current = 0`).
 *       `clamp` snaps to NEAREST, so the value leaves a settled detent once the
 *       residue reaches step/2 — but it advances a full step. Zeroing threw away
 *       the half-step that had not been paid for, so EVERY detent cost half what
 *       the pixel mapping intends and a full sweep took half the travel
 *       DRAG_RANGE_PX documents: 96px / 99px / 108px against 190.
 *
 *   (C) residue accumulated without bound at the min/max stops, because `clamp`
 *       cannot move the value there so nothing ever drained it. Shoving 200px
 *       past max bought 206px of dead travel before a reversal registered; a
 *       hard shove left the dial unresponsive for the rest of the gesture.
 *
 * DESIGN NOTES, because the obvious test does not work:
 *
 *  - Drags are driven ONE PIXEL PER EVENT. The handler accumulates into a ref
 *    across mousemove events, so a single large mousemove is a teleport that
 *    exercises none of the accumulation and cannot see either defect. The first
 *    version of this file made exactly that mistake and passed on the bug.
 *  - RotaryDial is CONTROLLED, so the harness feeds every committed value back
 *    via rerender, the way StepControlRoom does. Without that the handler keeps
 *    reading a stale `value` prop and wedges after one detent.
 *  - Assertions are about OBSERVED DRAG BEHAVIOUR, and prefer RATIOS between two
 *    measured drags over absolute pixel counts, so they survive a retune of how
 *    the travel budget is computed. The one place an absolute number is pinned
 *    names DRAG_RANGE_PX explicitly, because that constant meaning what it says
 *    IS defect (A).
 *  - Every measurement carries a CONTROL, so a harness that silently stopped
 *    driving the component fails loudly instead of passing vacuously.
 *
 * NOT covered here, deliberately: the per-detent FEEL. Travel is budgeted per
 * dial, so px-per-detent is still a function of the caller's range (11.2 on
 * Leverage against 1.91 on Liquidity). That is tracked in GH#2653 as a product
 * decision about the whole panel; asserting a feel here would pin a number this
 * change did not set out to choose.
 */

import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  RotaryDial,
  dragSweepPx,
  DRAG_MIN_SWEEP_PX,
  DRAG_MAX_SWEEP_PX,
} from "@/components/create/RotaryDial";

type Spec = { label: string; min: number; max: number; step: number };

/** The real Control Room call sites — StepControlRoom.tsx:146-181. */
const LEVERAGE: Spec = { label: "Leverage", min: 2, max: 10, step: 0.5 }; // 16 detents
const LIQUIDITY: Spec = { label: "Liquidity", min: 100, max: 10_000, step: 100 }; // 99 detents
const INSURANCE: Spec = { label: "Insurance", min: 100, max: 1_000, step: 25 }; // 36 detents

const detentsOf = (s: Spec) => (s.max - s.min) / s.step;

/** "the drag never produced the event we were waiting for" */
const NEVER = Number.POSITIVE_INFINITY;

/**
 * Mounts one dial and returns a driver for a SINGLE CONTINUOUS gesture: the
 * button goes down on construction and stays down until `end()`, so residue
 * carried between events is exercised the way a real drag does.
 */
function driveDial(spec: Spec, startValue: number) {
  // Unmount anything a previous drag left behind. Every mounted instance keeps
  // its own window mousemove listener, and two specs can share a label, so a
  // leak makes the harness ambiguous rather than merely wasteful.
  cleanup();

  let value = startValue;
  let commits = 0;
  const onChange = vi.fn((v: number) => {
    value = v;
    commits += 1;
  });

  const paint = () => <RotaryDial {...spec} value={value} format={String} onChange={onChange} />;
  const { rerender } = render(paint());
  const knob = screen.getByRole("slider", { name: spec.label });

  let y = 100_000; // far from zero so a long downward drag never runs negative
  fireEvent.mouseDown(knob, { clientY: y });

  /** One pixel of travel. dir +1 = up = increase, like a real dial. */
  const px = (dir: 1 | -1) => {
    y -= dir;
    fireEvent.mouseMove(window, { clientY: y });
    rerender(paint()); // the parent owns the value; hand the new one back
  };

  return {
    get value() {
      return value;
    },
    get commits() {
      return commits;
    },
    drag(n: number, dir: 1 | -1) {
      for (let i = 0; i < n; i++) px(dir);
    },
    /** Pixels until the value next changes, or NEVER. */
    pxUntilChange(dir: 1 | -1, limit = 6000) {
      const from = value;
      for (let i = 1; i <= limit; i++) {
        px(dir);
        if (value !== from) return i;
      }
      return NEVER;
    },
    /** Pixels until the value reaches `target`, or NEVER. */
    pxUntilValue(target: number, dir: 1 | -1, limit = 20_000) {
      for (let i = 1; i <= limit; i++) {
        px(dir);
        if (value === target) return i;
      }
      return NEVER;
    },
    touchCancel() {
      fireEvent.touchCancel(window);
    },
    end() {
      fireEvent.mouseUp(window);
    },
  };
}

/** Pixels of continuous upward drag to take a dial from min all the way to max. */
function fullSweepPx(spec: Spec): number {
  const d = driveDial(spec, spec.min);
  const px = d.pxUntilValue(spec.max, 1);
  d.end();
  return px;
}

/**
 * The cost of the FIRST detent leaving a settled value, and then of the SECOND.
 *
 * These differ by construction when the remainder is carried: the value leaves a
 * settled detent after half a detent's worth of travel, then holds for a full
 * one. A handler that discards the remainder charges half a detent every time,
 * so first ≈ second — which is defect (A) stated without naming any constant.
 */
function firstAndSecondDetentPx(spec: Spec, startValue: number) {
  const d = driveDial(spec, startValue);
  const first = d.pxUntilChange(1);
  const second = d.pxUntilChange(1);
  d.end();
  return { first, second };
}

describe("RotaryDial drag — controls (these pin the harness, not the fix)", () => {
  it("mounts a slider reachable by its accessible name", () => {
    render(<RotaryDial {...LEVERAGE} value={4} format={String} onChange={vi.fn()} />);
    expect(screen.getByRole("slider", { name: "Leverage" })).toBeTruthy();
  });

  it("a sub-detent nudge moves nothing, and a real drag moves the value", () => {
    // Both halves matter. If one pixel already moved the dial, every "pixels
    // until change" figure below would be 1 and the suite would measure nothing.
    // If 60px moved nothing, the suite would be measuring a component that never
    // received the events at all.
    const d = driveDial(LEVERAGE, 4);
    d.drag(1, 1);
    expect(d.commits).toBe(0);
    d.drag(60, 1);
    expect(d.commits).toBeGreaterThan(0);
    expect(d.value).toBeGreaterThan(4);
    d.end();
  });

  it("every dial under test can be swept end to end", () => {
    // Pins reachability once and explicitly, so the bounded assertions below
    // cannot be satisfied by a sweep that silently never finished.
    for (const spec of [LEVERAGE, LIQUIDITY, INSURANCE]) {
      expect(Number.isFinite(fullSweepPx(spec))).toBe(true);
    }
  });
});

describe("RotaryDial drag (A) — travel is carried, not discarded, on commit", () => {
  it.each([
    ["Leverage", LEVERAGE, 4],
    // Insurance, not Liquidity: at ~4px per detent (GH#2653) whole-pixel events
    // quantise the half-detent (2px) / full-detent (4px) costs too coarsely to
    // resolve a 1.5-2.6 ratio. Liquidity's carry is covered by the sweep test.
    ["Insurance", INSURANCE, 500],
  ] as const)("%s holds a detent for ~twice the travel it took to leave the last", (_n, spec, from) => {
    // Mechanism-free form of "the remainder is carried": reverting to
    // `residue.current = 0` makes these two equal.
    const { first, second } = firstAndSecondDetentPx(spec, from);
    expect(Number.isFinite(first)).toBe(true);
    expect(Number.isFinite(second)).toBe(true);
    expect(second / first).toBeGreaterThan(1.5);
    expect(second / first).toBeLessThan(2.6);
  });

  it.each([
    ["Leverage", LEVERAGE],
    ["Liquidity", LIQUIDITY],
    ["Insurance", INSURANCE],
  ] as const)("%s spends the documented travel on a full sweep", (_n, spec) => {
    // The one absolute assertion, and it names the constant on purpose: this
    // number meaning what it claims IS the defect. Before the fix these were
    // 96 / 99 / 108 against a documented 190.
    //
    // The lower bound allows one detent of slack, because the first detent off
    // `min` costs a half-step rather than a full one, so a sweep lands just
    // under the budget rather than exactly on it (measured 179 / 189 / 186).
    // (GH#2653: the budget is now derived per dial by dragSweepPx.)
    const documented = dragSweepPx(spec.min, spec.max, spec.step);
    const px = fullSweepPx(spec);
    const oneDetent = documented / detentsOf(spec);
    expect(px).toBeGreaterThan(documented - oneDetent - 1);
    expect(px).toBeLessThanOrEqual(documented + 1);
  });
});

describe("RotaryDial drag (C) — the stops do not go sticky", () => {
  /**
   * Shoves `overshoot` pixels INTO a stop the dial already rests on, then
   * reverses, reporting what the reversal cost.
   */
  function reversalAfterOvershoot(spec: Spec, at: "min" | "max", overshoot: number) {
    const stop = at === "max" ? spec.max : spec.min;
    const into: 1 | -1 = at === "max" ? 1 : -1;
    const back: 1 | -1 = at === "max" ? -1 : 1;

    const d = driveDial(spec, stop);
    d.drag(overshoot, into);
    const commitsWhileShoving = d.commits;
    const px = d.pxUntilChange(back);
    const landed = d.value;
    d.end();
    return { px, commitsWhileShoving, landed };
  }

  it.each([
    ["Leverage", LEVERAGE, "max"],
    ["Leverage", LEVERAGE, "min"],
    ["Liquidity", LIQUIDITY, "max"],
  ] as const)("%s costs the same to reverse off %s after 50px or 400px of shove", (_n, spec, at) => {
    // The strongest available form, and entirely constant-free: the cost of
    // reversing must not be a function of how hard the stop was pushed. With the
    // residue unbounded it is exactly linear in the overshoot.
    const gentle = reversalAfterOvershoot(spec, at, 50);
    const hard = reversalAfterOvershoot(spec, at, 400);

    // CONTROL: we were genuinely pinned at the stop — shoving produced no
    // commits at all, so these numbers describe residue behaviour AT a stop and
    // not some ordinary mid-range drag that happened to start near one.
    expect(gentle.commitsWhileShoving).toBe(0);
    expect(hard.commitsWhileShoving).toBe(0);
    // CONTROL: the reversal actually happened, and landed exactly one detent off
    // the stop rather than somewhere arbitrary.
    expect(Number.isFinite(gentle.px)).toBe(true);
    const expected = at === "max" ? spec.max - spec.step : spec.min + spec.step;
    expect(hard.landed).toBeCloseTo(expected, 10);

    expect(Math.abs(hard.px - gentle.px)).toBeLessThanOrEqual(3);
  });

  it("costs no more to leave a stop than to leave any settled value", () => {
    // A stop must behave like any other resting position: a dial pressed against
    // a mechanical stop stores no energy. Leaving one should cost the same half
    // detent that leaving a settled interior value costs.
    //
    // This is what distinguishes bounding the residue by the travel PHYSICALLY
    // REMAINING (zero at a stop) from bounding it to ±step/2, which also stops
    // the runaway but parks the residue AT the threshold — so leaving a stop
    // costs a whole detent where an interior move costs half. Both fix defect
    // (C); only one is symmetric, and without this assertion the ±step/2 form
    // passes every other test in this file.
    const { first: interiorFirstPx, second: steadyDetentPx } = firstAndSecondDetentPx(LEVERAGE, 6);
    expect(Number.isFinite(interiorFirstPx)).toBe(true);
    // CONTROL: the two interior costs really do differ, so `first` is the
    // half-detent figure and not an artefact of both being equal.
    expect(steadyDetentPx / interiorFirstPx).toBeGreaterThan(1.5);

    const hard = reversalAfterOvershoot(LEVERAGE, "max", 400);
    expect(hard.px / interiorFirstPx).toBeLessThan(1.5);
    // And still bounded well inside a full detent of ordinary travel.
    expect(hard.px).toBeLessThanOrEqual(steadyDetentPx * 1.2);
  });
});

describe("RotaryDial drag — an interrupted touch gesture ends", () => {
  it("stops tracking after touchcancel", () => {
    // Without a `touchcancel` listener the OS taking the touch (a system
    // gesture, an incoming call, a second finger) leaves `dragging` true with a
    // stale `lastY`, so the next touch slews the dial by the distance to the old
    // anchor — and `move` keeps calling preventDefault, which stops the PAGE
    // scrolling too.
    const d = driveDial(LEVERAGE, 6);
    d.drag(20, 1);
    const afterDrag = d.value;
    expect(d.commits).toBeGreaterThan(0); // CONTROL: the gesture was live

    d.touchCancel();
    const commitsAtCancel = d.commits;
    // A large jump that WOULD move the dial if it were still armed.
    d.drag(400, 1);
    expect(d.value).toBe(afterDrag);
    expect(d.commits).toBe(commitsAtCancel);
    d.end();
  });
});

describe("RotaryDial drag (GH#2653) — gearing is a property of the control", () => {
  const DIALS = [LEVERAGE, LIQUIDITY, INSURANCE];
  const pxPerDetent = (s: Spec) => fullSweepPx(s) / detentsOf(s);

  it("keeps a coarse dial at its documented floor (Leverage feel unchanged)", () => {
    expect(dragSweepPx(LEVERAGE.min, LEVERAGE.max, LEVERAGE.step)).toBe(DRAG_MIN_SWEEP_PX);
  });

  it("never asks for more travel than fits on a small phone", () => {
    for (const s of DIALS) {
      expect(dragSweepPx(s.min, s.max, s.step)).toBeLessThanOrEqual(DRAG_MAX_SWEEP_PX);
    }
    // an extreme dial is capped, not unbounded
    expect(dragSweepPx(0, 1_000_000, 1)).toBe(DRAG_MAX_SWEEP_PX);
  });

  it("narrows the feel spread across the three Control Room dials to <= ~3.2x (was ~6x)", () => {
    const per = DIALS.map(pxPerDetent);
    for (const v of per) expect(Number.isFinite(v)).toBe(true); // CONTROL
    const spread = Math.max(...per) / Math.min(...per);
    expect(spread).toBeLessThan(3.3);
  });

  it("a Liquidity detent is no longer within hand-jitter (>= 3px)", () => {
    expect(pxPerDetent(LIQUIDITY)).toBeGreaterThanOrEqual(3);
  });
});

describe("RotaryDial drag — listeners are not re-subscribed per detent", () => {
  it("adds each window listener once per gesture, however many detents it crosses", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      const d = driveDial(LEVERAGE, 2);
      const before = add.mock.calls.filter(([t]) => t === "mousemove").length;
      d.drag(150, 1); // crosses many detents, each one a re-render
      expect(d.commits).toBeGreaterThan(8); // CONTROL: real detents happened
      const during = add.mock.calls.filter(([t]) => t === "mousemove").length;
      expect(during).toBe(before);
      d.end();
      const removed = remove.mock.calls.filter(([t]) => t === "mousemove").length;
      expect(removed).toBeGreaterThanOrEqual(1);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it("a burst of moves between re-renders does not lose travel to a stale value", () => {
    // React batches native-listener updates, so several mousemoves can land
    // before the parent hands the new value back. Position must not depend on it.
    cleanup();
    const onChange = vi.fn();
    render(<RotaryDial {...LEVERAGE} value={2} format={String} onChange={onChange} />);
    const knob = screen.getByRole("slider", { name: "Leverage" });
    fireEvent.mouseDown(knob, { clientY: 10_000 });
    for (let y = 9_999; y >= 9_810; y--) fireEvent.mouseMove(window, { clientY: y }); // 190px, no rerender
    fireEvent.mouseUp(window);
    expect(onChange).toHaveBeenLastCalledWith(10); // full documented sweep reaches max
  });
});
