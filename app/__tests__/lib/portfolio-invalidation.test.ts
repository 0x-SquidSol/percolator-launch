/**
 * A freshly opened position took up to 30 seconds to appear in the site-wide
 * PositionsBar, while the same position showed on the trade page almost
 * immediately.
 *
 * `usePortfolio` refreshes its position list on a 30s interval
 * (usePortfolio.ts:1340). Closing already short-circuits that —
 * `OtherMarketPositions.tsx:349` passes `onClosed={portfolio.refresh}` — but
 * opening does not: `OrderTicket.tsx:821` calls only `refreshSlab()`, which
 * updates the trade page's own dock and tells the portfolio nothing.
 *
 * See lib/portfolio-invalidation.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PORTFOLIO_RECONCILE_MS,
  __resetPortfolioInvalidationForTests,
  invalidatePortfolio,
  subscribePortfolioInvalidation,
} from "@/lib/portfolio-invalidation";

afterEach(() => __resetPortfolioInvalidationForTests());

describe("portfolio invalidation reaches every listener", () => {
  it("notifies a subscriber", () => {
    const seen = vi.fn();
    subscribePortfolioInvalidation(seen);
    invalidatePortfolio();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("notifies every subscriber, not just the first", () => {
    // The bar, the dashboard widgets and the portfolio page can all be mounted
    // at once. Updating one and leaving the others stale is the bug wearing a
    // different hat.
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    subscribePortfolioInvalidation(a);
    subscribePortfolioInvalidation(b);
    subscribePortfolioInvalidation(c);
    invalidatePortfolio();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe", () => {
    const seen = vi.fn();
    const off = subscribePortfolioInvalidation(seen);
    off();
    invalidatePortfolio();
    expect(seen).not.toHaveBeenCalled();
  });

  it("CONTROL: one throwing listener does not silence the others", () => {
    // Load-bearing. Without the try/catch, a single broken widget stops the
    // header bar from ever updating — a worse failure than the one being
    // fixed, and invisible because the throw happens inside an event handler.
    const boom = vi.fn(() => {
      throw new Error("widget exploded");
    });
    const after = vi.fn();
    subscribePortfolioInvalidation(boom);
    subscribePortfolioInvalidation(after);

    expect(() => invalidatePortfolio()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: unsubscribing during a notification is safe", () => {
    // A listener that tears its own component down mid-notification must not
    // corrupt the iteration and skip the next subscriber.
    const after = vi.fn();
    const off = subscribePortfolioInvalidation(() => off());
    subscribePortfolioInvalidation(after);

    expect(() => invalidatePortfolio()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("is safe with no subscribers at all", () => {
    expect(() => invalidatePortfolio()).not.toThrow();
  });
});

describe("the reconciliation schedule", () => {
  it("spans the RPC account-data cache window", () => {
    // An immediate re-read returns the PRE-trade snapshot: /api/rpc caches
    // getAccountInfo ~1s and getProgramAccounts ~1.5s (usePortfolio.refresh's
    // own comment). At least one follow-up must land comfortably past that,
    // or the burst just re-publishes stale state three times.
    //
    // Note the shipped schedule opens at 1400ms, i.e. INSIDE the ~1.5s
    // getProgramAccounts window — that first shot can legitimately come back
    // pre-trade. It is kept as-is rather than retuned here: these timings are
    // useTrade's, they ship today, and moving them is a separate change with
    // its own evidence. What matters for correctness is that a LATER one
    // clears the window, which is asserted directly.
    const clearsWindow = PORTFOLIO_RECONCILE_MS.filter((ms) => ms > 1_500);
    expect(clearsWindow.length).toBeGreaterThanOrEqual(2);
  });

  it("CONTROL: is ascending and bounded", () => {
    // Without this, "add follow-ups" could become an unbounded retry storm
    // against a rate-limited endpoint, or land out of order.
    expect(PORTFOLIO_RECONCILE_MS.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < PORTFOLIO_RECONCILE_MS.length; i++) {
      expect(PORTFOLIO_RECONCILE_MS[i]).toBeGreaterThan(PORTFOLIO_RECONCILE_MS[i - 1]);
    }
    // ...and every follow-up lands well inside the 30s poll it is short-cutting.
    expect(PORTFOLIO_RECONCILE_MS.at(-1)!).toBeLessThan(30_000);
  });
});
