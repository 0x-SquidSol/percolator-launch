/**
 * Binds the fix to the source.
 *
 * `__tests__/lib/portfolio-invalidation.test.ts` covers the notification
 * mechanism. It cannot see whether opening a trade actually sends one — and
 * that was the entire bug, so the wiring IS the fix. Reverting OrderTicket and
 * usePortfolio leaves that suite green.
 *
 * Same technique, and the same reason, as create-market-launch-gate.test.ts.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const read = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, "../../", rel), "utf8");

const TICKET = read("components/trade/OrderTicket.tsx");
const PORTFOLIO = read("hooks/usePortfolio.ts");

describe("opening a position tells the portfolio", () => {
  it("OrderTicket announces the change after a successful open", () => {
    // THE BUG: it called only refreshSlab(), which updates the trade page's
    // own dock and tells usePortfolio nothing, so the header bar waited out
    // the 30s poll.
    expect(TICKET).toContain("invalidatePortfolio()");
  });

  it("the announcement is not buried inside the 1500ms timeout", () => {
    // The notification carries its own reconciliation burst, so delaying it
    // just adds 1.5s to the very latency being fixed.
    const idx = TICKET.indexOf("invalidatePortfolio()");
    // Line-ending agnostic: this file is CRLF on Windows checkouts, so a
    // literal "\n" needle silently never matches.
    const timeoutMatch = /setTimeout\(\(\) => \{\s*refreshSlab\(\);/.exec(TICKET);
    expect(idx).toBeGreaterThan(-1);
    expect(timeoutMatch, "the deferred refreshSlab() block").not.toBeNull();
    expect(idx).toBeLessThan(timeoutMatch!.index);
  });
});

describe("usePortfolio listens, and both paths share one schedule", () => {
  it("subscribes to the notification", () => {
    expect(PORTFOLIO).toContain("subscribePortfolioInvalidation(");
  });

  it("no longer hard-codes the reconciliation timings", () => {
    // Two copies of [1400, 2600, 4000] is how the open and close paths drift
    // apart again — the asymmetry this issue is about.
    expect(PORTFOLIO).not.toMatch(/\[\s*1400\s*,\s*2600\s*,\s*4000\s*\]/);
    expect(PORTFOLIO).toContain("PORTFOLIO_RECONCILE_MS");
  });

  it("CONTROL: the close path still refreshes", () => {
    // The fix must not trade one stale path for the other. Closing has worked
    // since `onClosed={portfolio.refresh}` was added, and must keep working.
    expect(read("components/trade/OtherMarketPositions.tsx")).toContain(
      "onClosed={portfolio.refresh}",
    );
    expect(PORTFOLIO).toMatch(/const refresh = \(\) => \{/);
  });
});
