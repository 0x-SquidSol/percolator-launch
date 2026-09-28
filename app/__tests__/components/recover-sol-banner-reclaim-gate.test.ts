/**
 * Binds the #2622 reclaim-gate fix to the source.
 *
 * The slab rent is only reclaimable while the market is still EMPTY — CloseSlab
 * requires no open user accounts and no capital, which is only true before Step 2
 * creates the LP portfolio (lastStep <= 2). The banner must (a) compute that
 * window, (b) render RECLAIM only inside it (so it never dead-ends), and (c) when
 * past it, tell the creator the rent is committed and the options are
 * Continue/Discard. A render test would need the whole wizard's stuck-slab
 * plumbing; the WIRING is the point, so — same technique as
 * create-market-price-gate.test.ts — we assert on the source.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const BANNER = fs.readFileSync(
  path.resolve(__dirname, "../../components/create/RecoverSolBanner.tsx"),
  "utf8",
);

/** Drop comments, so an assertion about CODE is not satisfied by prose. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("#2622 reclaim is gated on the empty-market window", () => {
  it("computes reclaimability from the last-completed step (before the LP portfolio)", () => {
    expect(code(BANNER)).toMatch(/const reclaimable = resumeFromStep <= 2/);
  });

  it("renders the RECLAIM button only when reclaimable — never a dead-end", () => {
    const c = code(BANNER);
    const guard = c.indexOf("{reclaimable && (");
    const reclaimBtn = c.indexOf("RECLAIM ~");
    expect(guard).toBeGreaterThan(-1); // the gate exists
    expect(reclaimBtn).toBeGreaterThan(guard); // the button is inside the gate
  });

  it("tells the creator, when it's not reclaimable, that the rent is committed", () => {
    // Both branches of the status copy must exist (real string literals, so this
    // survives comment-stripping / can't be satisfied by the doc comment).
    expect(BANNER).toContain("committed and can no longer be reclaimed");
    expect(BANNER).toContain("last point the rent can be reclaimed");
  });
});
