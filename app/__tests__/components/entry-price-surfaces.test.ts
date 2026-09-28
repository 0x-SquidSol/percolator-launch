/**
 * Binds the entry-price rollout to the source (GH#2660).
 *
 * `entry-price-display.test.tsx` covers the two surfaces this change fixed. It
 * cannot see a SIXTH surface being added next month with a third spelling of
 * the same decision — and that is precisely how this defect arrived: five
 * surfaces each re-derived "may I show this entry price?" and two got it wrong,
 * in opposite directions.
 *
 * `resolveEntryPrice` states the rule in prose ("only DISPLAY should branch on
 * `source`"). Prose does not fail a build. This file does.
 *
 * The surface list is DISCOVERED by walking the tree for a user-visible "Entry"
 * label, not hand-maintained — the lesson from #2634, where an "every surface"
 * comment sat above an array of four of nine.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const APP_ROOT = path.resolve(__dirname, "../../");

/**
 * Comments are stripped before ANY match. `PositionSummary` legitimately
 * mentions `account.entryPrice` in a comment explaining why it must not read
 * it — an assertion a comment can satisfy (or trip) is not an assertion.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => (l.indexOf("//") === -1 ? l : l.slice(0, l.indexOf("//"))))
    .join("\n");
}

/** A user-visible "Entry" / "Entry Price" label — i.e. a surface that SHOWS one. */
const ENTRY_LABEL = /(>\s*Entry(\s+Price)?\s*<|"Entry(\s+Price)?"|Entry:\s*<\/span>|>Entry:\s)/;

function discoverEntrySurfaces(): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === ".next") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(".tsx")) {
        const src = stripComments(fs.readFileSync(full, "utf8"));
        if (ENTRY_LABEL.test(src)) {
          found.push([path.relative(APP_ROOT, full).split(path.sep).join("/"), src]);
        }
      }
    }
  };
  for (const r of ["components", "app"]) walk(path.resolve(APP_ROOT, r));
  return found.sort((a, b) => a[0].localeCompare(b[0]));
}

const SURFACES = discoverEntrySurfaces();

/**
 * Surfaces that show an "Entry" label but do not owe the position-entry gate.
 * Each needs a reason, and the reason is asserted to still name a real file.
 */
const EXEMPT: Record<string, string> = {
  "components/trade/AccountsCard.tsx":
    "Renders pre-v17 accounts only. SlabProvider hands it `accounts: []` on a " +
    "v17 market (SlabProvider.tsx:387) and populates it from the SDK's " +
    "parseAllAccounts otherwise, where entry_price IS decoded from chain — so " +
    "`row.entryPrice > 0n` is a real test there, not the structural zero it " +
    "would be on v17.",
  "components/trade/OrderTicket.tsx":
    "Shows the PROJECTED entry for the order about to be placed (a DiffRow " +
    "from '—' to the estimated fill), not a held position's recovered entry. " +
    "There is no `source` to gate on because nothing has been filled yet.",
  "components/trade/TradingChart.tsx":
    "Draws an entry LINE, not a readout, and only when a real cached entry " +
    "exists — it returns null otherwise and the line is simply absent. An " +
    "absent line makes no claim, which is the distinction that matters: it " +
    "never falls back to the mark and so cannot fabricate an entry.",
};

describe("the entry-price surface list is discovered, not hand-maintained", () => {
  it("finds the surfaces that show an entry price", () => {
    // CONTROL: a broken walk or a bad predicate yields an empty list and makes
    // every assertion below pass vacuously — which is how #2634's hand-list
    // failed, one step removed.
    const names = SURFACES.map(([n]) => n);
    expect(names).toEqual(
      expect.arrayContaining([
        "components/dashboard/PositionSummary.tsx",
        "components/portfolio/PortfolioPositionsView.tsx",
        "components/trade/PositionsDock.tsx",
        "components/trade/PositionPanel.tsx",
        "components/trade/OtherMarketPositions.tsx",
      ]),
    );
    // Pinned exactly, not floored: ">= n" lets a surface silently disappear.
    // Adding one should fail here and require a reviewed one-line edit.
    expect(SURFACES.length).toBe(8);
  });

  it("every exemption still names a discovered surface", () => {
    // A stale exemption is how a surface loses its gate after a rename.
    const names = new Set(SURFACES.map(([n]) => n));
    for (const exempt of Object.keys(EXEMPT)) expect(names).toContain(exempt);
  });

  it("every exemption gives a reason", () => {
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${name} needs a real reason`).toBeGreaterThan(40);
    }
  });
});

describe("no surface renders the RAW on-chain entry price", () => {
  it.each(SURFACES)("%s does not format account.entryPrice", (_name, src) => {
    // THE defect this file exists for. v17 hard-codes `entryPrice: 0n`
    // (userAccountScan.ts:153 — "v17 genuinely does not store one"), so
    // formatting it renders a dash on every position forever. Reading it to
    // FEED resolveEntryPrice is fine and several surfaces legitimately do;
    // handing it to a price formatter is not.
    expect(src).not.toMatch(/format\w*\(\s*[\w?.]*account[\w?.]*\.entryPrice/);
  });
});

describe("every entry-price readout gates on whether the entry resolved", () => {
  const CELLS = SURFACES.filter(([n]) => !EXEMPT[n]);

  it("there is something left to check after exemptions", () => {
    // Guards the it.each blocks below against being empty — an exemption added
    // for every surface would otherwise turn this file green and silent.
    expect(CELLS.length).toBeGreaterThanOrEqual(5);
  });

  it.each(CELLS)("%s uses one of the two approved shapes", (_name, src) => {
    // Shape A — the shared helper, which returns the text AND the boolean:
    //     const entryDisplay = describeEntryPrice({...});  {entryDisplay.text}
    // Shape B — the older explicit gate the trade surfaces use, kept because
    // their unknown branch renders an InfoIcon rather than plain text:
    //     {pnlIsKnown ? formatUsdPriceE6(entryPriceE6) : (<InfoIcon .../>)}
    //
    // Anything else is a third re-derivation of this decision, which is what
    // produced the bug. Both defects matched NEITHER shape: one formatted the
    // raw field, the other formatted the resolved value with no gate at all.
    const usesHelper = /describeEntryPrice\(/.test(src) && /\{\s*\w*[eE]ntryDisplay\.text\s*\}/.test(src);
    const usesExplicitGate =
      /pnlIsKnown\s*(&&[^?]*)?\?\s*format\w*\(/.test(src) &&
      /[sS]ource\s*!==\s*"unknown"/.test(src);
    expect(
      usesHelper || usesExplicitGate,
      "must derive its Entry cell from describeEntryPrice(), or gate a formatter on resolveEntryPrice().source",
    ).toBe(true);
  });
});

describe("CONTROL: the helper the surfaces are asserted against is real", () => {
  it("exports what the assertions look for", () => {
    const helper = fs.readFileSync(path.resolve(APP_ROOT, "lib/trading.ts"), "utf8");
    expect(helper).toContain("export function describeEntryPrice(");
    expect(helper).toContain('export type EntryPriceSource = "cache" | "derived" | "unknown"');
  });
});
