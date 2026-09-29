/**
 * Structural guard for the entry-price rollout (#2660 / #2671 / #2673).
 *
 * `entry-price-surfaces.test.tsx` renders the surfaces #2660 fixed. It cannot
 * see a NEW surface added next month with another spelling of "may I show this
 * entry?" — which is how #2660 arrived: several surfaces each re-derived that
 * decision and two got it wrong, in opposite directions.
 *
 * The surface list is DISCOVERED by walking the tree for a user-visible "Entry"
 * label, not hand-maintained (the #2634 lesson). Adapted from #2671
 * (@0x-SquidSol) onto the lib/entry-price-display helper that landed first.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { describeEntryPrice, displayEntryE6, isEntryKnown } from "@/lib/entry-price-display";
import type { EntryPriceSource } from "@/lib/trading";

const APP_ROOT = path.resolve(__dirname, "../../");

/** Comments are stripped before ANY match: a comment must not satisfy (or trip) an assertion. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => (l.indexOf("//") === -1 ? l : l.slice(0, l.indexOf("//"))))
    .join("\n");
}

function walkTsx(onFile: (rel: string, src: string) => void): void {
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === ".next" || ent.name === "__tests__") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(".tsx")) {
        onFile(path.relative(APP_ROOT, full).split(path.sep).join("/"), stripComments(fs.readFileSync(full, "utf8")));
      }
    }
  };
  for (const r of ["components", "app"]) walk(path.resolve(APP_ROOT, r));
}

/** A user-visible "Entry" / "Entry Price" label — i.e. a surface that SHOWS one. */
const ENTRY_LABEL = /(>\s*Entry(\s+Price)?\s*<|"Entry(\s+Price)?"|Entry:\s*<\/span>|>Entry:\s)/;

function discoverEntrySurfaces(): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  walkTsx((rel, src) => {
    if (ENTRY_LABEL.test(src)) found.push([rel, src]);
  });
  return found.sort((a, b) => a[0].localeCompare(b[0]));
}

const SURFACES = discoverEntrySurfaces();

/** Surfaces with an "Entry" label that do not owe the position-entry gate — each with a reason. */
const EXEMPT: Record<string, string> = {
  "components/trade/AccountsCard.tsx":
    "Renders pre-v17 accounts only: SlabProvider hands it `accounts: []` on a v17 market and fills it " +
    "from parseAllAccounts otherwise, where entry_price IS decoded from chain — so `entryPrice > 0n` is a " +
    "real test there, not the structural zero it is on v17.",
  "components/trade/OrderTicket.tsx":
    "Its 'Entry' DiffRow is the PROJECTED fill for the order about to be placed, not a held position's " +
    "recovered entry. The held entry it passes to the Close panel is checked by the call-site guard below.",
  "components/trade/TradingChart.tsx":
    "Draws an entry LINE only from a real stored/cached entry and returns null otherwise — an absent " +
    "line makes no claim and never falls back to the mark.",
};

describe("the entry-price surface list is discovered, not hand-maintained", () => {
  it("finds the surfaces that show an entry price", () => {
    // CONTROL: a broken walk or predicate yields [] and every check below passes vacuously.
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
    // Pinned exactly: adding a surface must fail here and get a reviewed edit.
    expect(names.length).toBe(8);
  });

  it("every exemption still names a discovered surface, with a real reason", () => {
    const names = new Set(SURFACES.map(([n]) => n));
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(names).toContain(name);
      expect(reason.length, `${name} needs a real reason`).toBeGreaterThan(40);
    }
  });
});

describe("no surface formats the RAW on-chain entry price", () => {
  it.each(SURFACES)("%s does not format account.entryPrice", (_name, src) => {
    // v17/v18 hard-code `entryPrice: 0n`; formatting it renders a dash forever
    // (#2660 defect 1). Reading it to FEED resolveEntryPrice is fine.
    expect(src).not.toMatch(/format\w*\(\s*[\w?.]*account[\w?.]*\.entryPrice/);
  });
});

describe("every entry-price readout gates on whether the entry resolved", () => {
  const CELLS = SURFACES.filter(([n]) => !EXEMPT[n]);

  it("there is something left to check after exemptions", () => {
    expect(CELLS.length).toBeGreaterThanOrEqual(5);
  });

  it.each(CELLS)("%s uses one of the two approved shapes", (_name, src) => {
    // A — the shared helper (text AND boolean): describeEntryPrice(...) → {entryDisplay.text}
    // B — the trade-terminal gate whose unknown branch is an InfoIcon / "--":
    //     {pnlIsKnown ? formatUsdPriceE6(entryPriceE6) : ...}
    const usesHelper = /describeEntryPrice\(/.test(src) && /\{\s*\w*[eE]ntryDisplay\.text\s*\}/.test(src);
    const usesExplicitGate =
      /pnlIsKnown\s*(&&[^?]*)?\?\s*format\w*\(/.test(src) &&
      /([sS]ource\s*!==\s*"unknown"|isEntryKnown\()/.test(src);
    expect(usesHelper || usesExplicitGate).toBe(true);
  });
});

describe("the helper is an ALLOWLIST (#2671)", () => {
  const ENTRY = 19_400n;
  it.each<[EntryPriceSource]>([["cache"], ["derived"]])("%s → known", (source) => {
    expect(isEntryKnown(ENTRY, source)).toBe(true);
    expect(displayEntryE6(ENTRY, source)).toBe(ENTRY);
  });

  it.each([["unknown"], [undefined], [null], ["onchain"]])(
    "source=%s → unknown: the mark is never shown as the entry",
    (source) => {
      const s = source as unknown as EntryPriceSource;
      expect(isEntryKnown(ENTRY, s)).toBe(false);
      expect(displayEntryE6(ENTRY, s)).toBe(0n);
      const d = describeEntryPrice({ entryE6: ENTRY, source: s });
      expect(d.known).toBe(false);
      expect(d.text).toBe("—");
    },
  );

  it("over-correction control: a trusted source still shows its number", () => {
    expect(describeEntryPrice({ entryE6: ENTRY, source: "cache", formatPrice: (e) => `P${e}` }).text).toBe("P19400");
  });

  it("a non-positive entry is never shown even with a trusted source", () => {
    expect(isEntryKnown(0n, "derived")).toBe(false);
    expect(isEntryKnown(-5n, "cache")).toBe(false);
    expect(isEntryKnown(undefined, "cache")).toBe(false);
  });
});
