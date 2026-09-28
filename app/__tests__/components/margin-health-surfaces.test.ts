/**
 * Binds the margin-health rollout to the source.
 *
 * `__tests__/lib/margin-health.test.ts` covers the formula. It cannot see
 * whether the surfaces that show a liquidation price actually display it — and
 * "it is on exactly one of five surfaces" was the entire issue (#2558), so the
 * wiring IS the fix. Reverting every component leaves that suite green.
 *
 * GH#2634: the surface list used to be a hand-written array of the four
 * components #2558 fixed, under a comment claiming it was every one of them.
 * Nine consume a liquidation price, so the assertions were true of the LIST and
 * not of the codebase, and adding a fifth surface failed nothing. That is the
 * same defect this file exists to prevent — a hand-maintained copy drifting
 * from the thing it describes.
 *
 * The list is now DISCOVERED from the tree. A surface is either wired to the
 * shared helper or explicitly exempt WITH A REASON; there is no third state,
 * and in particular a surface can no longer be uncovered merely by being absent
 * from a list nobody remembered to update.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const APP_ROOT = path.resolve(__dirname, "../../");

/**
 * Comments are removed before any assertion. Review satisfied every one of them
 * with a TODO block that explicitly said the surface was NOT wired:
 *   // TODO(GH#2634): wire margin health here too. The shape would be
 *   //   const marginHealthPct = computeMarginHealthPct(...)
 * A guard that a comment can satisfy is not a guard.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => (l.indexOf("//") === -1 ? l : l.slice(0, l.indexOf("//"))))
    .join("\n");
}
const read = (rel: string) => fs.readFileSync(path.resolve(APP_ROOT, rel), "utf8");

/**
 * A component CONSUMES a trader's liquidation price if it references one of the
 * values, rather than merely containing the word "Liq" in a menu label or an
 * analytics heading — the first predicate tried here, which swept in
 * ChartDisplayMenu, SlabProvider and the markets page.
 */
const LIQ_PRICE_VALUE = /\b(liqPrice|liqPriceE6|liquidationPrice|liquidationPriceE6|estimatedLiqPrice|afterLiqPrice)\b/;

function discoverLiqPriceSurfaces(): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === ".next") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(".tsx")) {
        const src = fs.readFileSync(full, "utf8");
        if (LIQ_PRICE_VALUE.test(src)) found.push([path.relative(APP_ROOT, full).split(path.sep).join("/"), stripComments(src)]);
      }
    }
  };
  for (const r of ["components", "app"]) walk(path.resolve(APP_ROOT, r));
  return found.sort((a, b) => a[0].localeCompare(b[0]));
}

const SURFACES = discoverLiqPriceSurfaces();

/**
 * Surfaces that consume a liquidation price but do not owe a margin-health
 * readout. Each needs a reason, and the reason is asserted to still apply.
 */
const EXEMPT: Record<string, string> = {
  "components/trade/TradingChart.tsx":
    "Draws a price LINE on the chart, not a readout. When cross collateral " +
    "removes the liquidation price the line is simply absent, which is not the " +
    "same failure as a '-' where a number belongs: nothing claims a risk figure " +
    "and then withholds it. The numeric risk readouts live in PositionPanel and " +
    "PositionsDock, both of which sit on the same screen.",
  "components/trade/TradeConfirmationModal.tsx":
    "Already shows an account-level risk number, as Risk Lev. Margin health is " +
    "its exact reciprocal - health = capital/notional*100, risk leverage = " +
    "notional/capital, so health = 100/riskLev (verified: 210/200 gives 105.0% " +
    "and 0.95x). Adding both would print one number twice in different units. " +
    "It also receives no maintenance-margin prop, so it could not derive the " +
    "per-market unliquidatable threshold to label it against.",
};

describe("the surface list is discovered, not hand-maintained", () => {
  it("finds the components #2558 already covered", () => {
    // CONTROL: a broken walk or a bad predicate yields an empty or tiny list and
    // makes every assertion below pass vacuously — which is how the hand-list
    // failed, one step removed.
    const names = SURFACES.map(([n]) => n);
    expect(names).toEqual(
      expect.arrayContaining([
        "components/trade/PositionPanel.tsx",
        "components/trade/PositionsDock.tsx",
        "components/trade/OtherMarketPositions.tsx",
        "components/portfolio/PortfolioPositionsView.tsx",
      ]),
    );
    // Pinned exactly, not floored: ">= 8" against 9 surfaces let any single one
    // disappear. Adding a surface should fail loudly and require a reviewed
    // one-line edit here — that is the point of the guard.
    expect(SURFACES.length).toBe(9);
  });

  it("does not sweep in files that merely mention the word", () => {
    // The first predicate matched /Liq\b.../ anywhere and pulled in a chart
    // menu, a provider and the markets page. Pinning the exclusions keeps the
    // discovery honest in the other direction.
    const names = SURFACES.map(([n]) => n);
    for (const notASurface of [
      "components/trade/ChartDisplayMenu.tsx",
      "components/providers/SlabProvider.tsx",
      "components/trade/EngineHealthCard.tsx",
    ]) {
      expect(names).not.toContain(notASurface);
    }
  });

  it("every exemption still names a real surface", () => {
    // A stale exemption is how a surface silently loses coverage after being
    // renamed or after it stops rendering a liquidation price at all.
    const names = new Set(SURFACES.map(([n]) => n));
    for (const exempt of Object.keys(EXEMPT)) expect(names).toContain(exempt);
  });
});

describe("every surface showing a liquidation price also has margin health", () => {
  it.each(SURFACES)("%s is wired to the shared helper, or exempt with a reason", (name, src) => {
    if (EXEMPT[name]) {
      expect(EXEMPT[name].length).toBeGreaterThan(40);
      return;
    }
    expect(src).toContain("computeMarginHealthPct(");
  });

  it.each(SURFACES)("%s does not re-derive the formula locally", (_name, src) => {
    // The formula lived inline in PositionPanel and nowhere else. A second
    // copy is how the surfaces drift apart again.
    expect(src).not.toMatch(/capital\s*\*\s*1_000_000n\s*\*\s*100n\s*\/\s*notionalE6/);
  });
});

describe("the threshold is derived, never hard-coded", () => {
  const CELLS = SURFACES.filter(([n]) => !EXEMPT[n]);

  it.each(CELLS)("%s derives it from the market's maintenance margin", (_name, src) => {
    // 105 is only correct at mm = 500. A market with a different maintenance
    // margin gets a different line, and hard-coding it would mislabel them.
    expect(src).toContain("unliquidatableHealthThresholdPct(");
    // Not just called — the derived value must reach a RENDERED expression. The
    // literal check alone missed `past the ${105.0}%`: the interpolation braces
    // separate the digits from the percent sign, and 105.0 is exactly the shape
    // the surrounding toFixed invites.
    //
    // Three spellings are in use and all are fine: `${healthThresholdPct}` in a
    // template literal (PositionsDock), `${unliquidatableHealthThresholdPct(x)}`
    // called inline (AccountsCard), and `{healthThresholdPct}%` as a JSX
    // expression (PortfolioPositionsView). What is asserted is that it is
    // brace-wrapped somewhere, i.e. rendered rather than merely computed.
    expect(src).toMatch(/\{\s*(healthThresholdPct|unliquidatableHealthThresholdPct\()/);
    expect(src).not.toMatch(/\b105(\.\d+)?\s*%/);
  });
});

describe("the figure is gated on a RESOLVED ENTRY, not a bare zero", () => {
  const CELLS = SURFACES.filter(([n]) => !EXEMPT[n]);

  it.each(CELLS)("%s requires an entry price before claiming unliquidatable", (_name, src) => {
    // computeLiqPrice returns 0n for TWO unrelated reasons: the long
    // over-collateralisation clamp, and entryPrice === 0n, which means "no
    // data". lib/liquidation-state.ts names this distinction and says it "is
    // the same condition the three position components already use".
    //
    // Three surfaces shipped in this change gated on the bare zero, so they
    // asserted "cannot be liquidated by price" over a gap in the data — a false
    // safety claim, and for a SHORT it is always that case, because
    // computeLiqPrice never returns 0n for a short with a resolved entry.
    //
    // The previous assertions here could not see the difference: they matched
    // the helper CALL, not the condition it is called under.
    const gatesOnEntry =
      /entryPrice[^>]{0,40}>\s*0n/.test(src) ||
      /entryPriceE6\s*>\s*0n/.test(src) ||
      /entryE6\s*>\s*0n/.test(src) ||
      /combinedEntryPriceE6\s*>\s*0n/.test(src) ||
      /classifyLiquidation\(/.test(src);
    expect(gatesOnEntry).toBe(true);
  });
});

/**
 * KNOWN LIMIT, recorded rather than implied.
 *
 * Every assertion below is a regex over source text, so it cannot tell WHERE a
 * value lands. Review demonstrated the consequence: replacing PositionPanel's
 * cell with a hard-coded dash still passes, because the tooltip a few lines
 * above it also interpolates marginHealthPct — the identifier is present, just
 * not where it matters.
 *
 * Only rendering closes that. `__tests__/components/trade/OrderTicket.leverage-input.test.tsx`
 * shows the shape (the sibling DepositWithdrawCard test is the template), and
 * doing it here for seven surfaces is worth its own change rather than a rider
 * on this one. Until then: these assertions prove the wiring EXISTS, not that
 * the figure reaches the cell.
 */
describe("margin health is shown where the liquidation price is absent", () => {
  const CELLS = SURFACES.filter(([n]) => !EXEMPT[n]);

  it.each(CELLS)("%s renders the figure instead of a bare symbol", (_name, src) => {
    // The point of the issue: a dash or an infinity sign is not a risk
    // number. Where there is no liquidation price, show the one that exists.
    //
    // The leading char is a class because a surface may qualify the name —
    // OrderTicket's is `afterMarginHealthPct`, since it projects the value for
    // the order about to be placed rather than reporting a current one.
    expect(src).toMatch(/[Mm]arginHealthPct\s*!=\s*null/);
    // And the figure actually reaches the DOM, not just a local variable.
    // Precision is deliberately not pinned: PortfolioPositionsView renders 0dp
    // in a dense table row while the others render 1dp. Worth reconciling, but
    // that is a formatting decision and not what this file guards.
    expect(src).toMatch(/[Mm]arginHealthPct\.toFixed\(\d\)/);
  });
});

describe("CONTROL: the helper the surfaces are asserted against is real", () => {
  it("exports what the assertions look for", () => {
    const helper = read("lib/margin-health.ts");
    expect(helper).toContain("export function computeMarginHealthPct(");
    expect(helper).toContain("export function unliquidatableHealthThresholdPct(");
  });
});
