/**
 * /markets list prices stopped flashing green-up / red-down on a change. The
 * live-ticking cell (LiveRowPrice) rendered the streamed price but had no flash —
 * it just formatted the number. This binds the fix to source: the cell now reads
 * the exact e6 tick value and runs it through the shared usePriceFlash (the same
 * hook the trade page's mark uses), colouring long-green on an up-tick and
 * short-red on a down-tick with a transition back to neutral.
 *
 * usePriceFlash's own up/down behaviour is the proven MarketInfoBar
 * implementation; here we only guard the list cell's wiring (a full render needs
 * the WS price store + useSyncExternalStore, so source-bind it).
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../app/markets/page.tsx"),
  "utf8",
);

describe("/markets LiveRowPrice flash (#price-flash)", () => {
  it("imports the shared usePriceFlash hook", () => {
    expect(SRC).toMatch(/import \{ usePriceFlash \} from ["']@\/hooks\/usePriceFlash["']/);
  });

  it("flashes off the exact e6 tick value, not the rounded USD float", () => {
    expect(SRC).toMatch(/getSnapshot\(slab\)\.priceE6/);
    expect(SRC).toMatch(/usePriceFlash\(\s*liveE6\s*\)/);
  });

  it("colours up-ticks long-green and down-ticks short-red with a transition", () => {
    expect(SRC).toMatch(/flash === "up" \? "text-\[var\(--long\)\]" : flash === "down" \? "text-\[var\(--short\)\]"/);
    expect(SRC).toMatch(/transition-colors/);
  });
});
