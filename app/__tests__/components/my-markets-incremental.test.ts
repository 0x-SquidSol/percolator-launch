/**
 * Binds the fix to the source.
 *
 * `__tests__/lib/incremental-details.test.ts` covers the merge rules. It cannot
 * see whether the page uses them — and the defect was entirely the page's
 * `Promise.all(...).then(setDetails)`, so the wiring IS the fix. Reverting
 * my-markets/page.tsx leaves that suite green.
 *
 * Same technique, and the same reason, as create-market-launch-gate.test.ts.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const PAGE = fs.readFileSync(
  path.resolve(__dirname, "../../app/my-markets/page.tsx"),
  "utf8",
);

/** Assert about CODE, not about a comment explaining the old behaviour. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("rows resolve independently", () => {
  it("no longer publishes the whole map in one Promise.all", () => {
    // THE BUG: nothing rendered until the slowest market settled — measured
    // 1022ms against 517ms for the fastest four.
    expect(code(PAGE)).not.toMatch(/Promise\.all\(/);
  });

  it("merges each detail as it lands, through the shared rule", () => {
    expect(code(PAGE)).toContain("applyResolved(");
    // Functional setState: a plain replace would make each arrival wipe the
    // previous one, which is worse than the all-at-once behaviour.
    expect(code(PAGE)).toMatch(/setDetails\(\s*\(prev\)\s*=>\s*applyResolved\(/);
  });

  it("passes the current slab list as the allow-list", () => {
    // Without it a late response from a previous wallet paints another
    // creator's market into this list.
    expect(code(PAGE)).toMatch(/applyResolved\(prev,\s*\{\s*slab,\s*detail:\s*d\s*\},\s*list\)/);
  });
});

describe("the identity cache is read, not only written", () => {
  it("seeds from the cache before any request", () => {
    // The page wrote every resolved identity here and never read it back, so a
    // return visit re-showed mint addresses with the answer already in memory.
    expect(code(PAGE)).toContain("getMarketIdentity(");
    expect(code(PAGE)).toContain("seedFromCache");
  });

  it("CONTROL: still WRITES the cache, so other pages keep their seed", () => {
    // The write exists for /trade/[slab], which must not flash a placeholder
    // name for a market the creator just clicked into. Reading must not
    // replace writing.
    expect(code(PAGE)).toContain("setMarketIdentity(");
  });
});
