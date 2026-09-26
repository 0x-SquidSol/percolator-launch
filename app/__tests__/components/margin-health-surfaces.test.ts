/**
 * Binds the margin-health rollout to the source.
 *
 * `__tests__/lib/margin-health.test.ts` covers the formula. It cannot see
 * whether the surfaces that show a liquidation price actually display it — and
 * "it is on exactly one of five surfaces" was the entire issue (#2558), so the
 * wiring IS the fix. Reverting every component leaves that suite green.
 *
 * Same technique, and the same reason, as create-market-launch-gate.test.ts.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const read = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, "../../", rel), "utf8");

/** Every surface that renders a liquidation price to a trader. */
const SURFACES: Array<[string, string]> = [
  ["PositionPanel", read("components/trade/PositionPanel.tsx")],
  ["PositionsDock", read("components/trade/PositionsDock.tsx")],
  ["OtherMarketPositions", read("components/trade/OtherMarketPositions.tsx")],
  ["PortfolioPositionsView", read("components/portfolio/PortfolioPositionsView.tsx")],
];

describe("every surface showing a liquidation price also has margin health", () => {
  it.each(SURFACES)("%s computes it from the shared helper", (_name, src) => {
    expect(src).toContain("computeMarginHealthPct(");
  });

  it.each(SURFACES)("%s does not re-derive the formula locally", (_name, src) => {
    // The formula lived inline in PositionPanel and nowhere else. A second
    // copy is how the four surfaces drift apart again.
    expect(src).not.toMatch(/capital\s*\*\s*1_000_000n\s*\*\s*100n\s*\/\s*notionalE6/);
  });
});

describe("the threshold is derived, never hard-coded", () => {
  it.each(SURFACES.filter(([n]) => n !== "PositionPanel"))(
    "%s derives it from the market's maintenance margin",
    (_name, src) => {
      // 105 is only correct at mm = 500. A market with a different maintenance
      // margin gets a different line, and hard-coding it would mislabel them.
      expect(src).toContain("unliquidatableHealthThresholdPct(");
      expect(src).not.toMatch(/\b105\s*%/);
    },
  );
});

describe("margin health is shown where the liquidation price is absent", () => {
  const CELLS: Array<[string, string]> = SURFACES.filter(
    ([n]) => n !== "PositionPanel",
  ) as Array<[string, string]>;

  it.each(CELLS)("%s renders the figure instead of a bare symbol", (_name, src) => {
    // The point of the issue: a dash or an infinity sign is not a risk
    // number. Where there is no liquidation price, show the one that exists.
    expect(src).toMatch(/marginHealthPct\s*!=\s*null/);
    expect(src).toContain("% mgn");
  });
});
