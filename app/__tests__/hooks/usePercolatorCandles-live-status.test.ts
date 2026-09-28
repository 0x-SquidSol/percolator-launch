/**
 * Binds the live-fill-visibility fix to the source.
 *
 * The interesting part is the WIRING, not the bucketing: the `ws.onmessage`
 * trade handler must set `status` to "success" after it appends/updates a bar,
 * or the fill sits in `candles` while `status` stays "empty" — and
 * chart-source-select only picks the Percolator series on `status === "success"`,
 * so the user's own trade into a previously-empty market stays invisible until
 * the next (slab, timeframe) refetch. A pure-data test of the bucketing cannot
 * see that. See #2609 (and #2604, the sibling fix in the same handler).
 *
 * Same source-reading technique, and the same reason, as
 * create-market-price-gate.test.ts.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const HOOK = fs.readFileSync(
  path.resolve(__dirname, "../../hooks/usePercolatorCandles.ts"),
  "utf8",
);

function slice(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("a live fill surfaces without a refetch", () => {
  it("the ws.onmessage trade handler sets status to success after appending", () => {
    // Scoped to the message handler (up to the effect cleanup `return () =>`) so
    // this cannot be satisfied by fetchData's own setStatus("success") on the
    // historical path — the whole point is that the LIVE path was missing it.
    const handler = slice(HOOK, "ws.onmessage", "return () =>");
    expect(handler).toContain("setCandles(");
    expect(handler).toContain('setStatus("success")');
  });
});
