/**
 * #2729 — a market's creator can only CLOSE on their own market (wrapper
 * SameOwnerTrade). The ticket's `sameOwner` block is fed by the risk-limits feed
 * (`ticketLimits.sameOwner`), which is feature-flagged and loads async — so when it
 * is off/unready the Open tab wasn't blocked and the creator submitted a doomed
 * order that failed with a generic message.
 *
 * This binds the fix to source: OrderTicket also derives `isOwnMarket` from market
 * IDENTITY (deployer / creator_fee_authority == connected wallet), which is always
 * loaded on the trade page, and ORs it into the ticket's `sameOwner` so the Open tab
 * shows the clear close-only reason regardless of the limits feed. The resulting
 * ticket-state behaviour (sameOwner -> paused close-only) is unit-tested in
 * lib/limits/ticket-state.test.ts; the resolver backstop in
 * lib/ux-wp1-gate-and-resolver.test.ts. A behavioural render isn't practical (the
 * ticket needs wallet + connection + market context), so this is source-bound.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../../components/trade/OrderTicket.tsx"),
  "utf8",
);

describe("OrderTicket — own-market close-only (#2729)", () => {
  it("derives isOwnMarket from deployer / creator_fee_authority vs the connected wallet", () => {
    expect(SRC).toMatch(/const isOwnMarket = useMemo\(/);
    expect(SRC).toMatch(/publicKey\.toBase58\(\)/);
    expect(SRC).toMatch(/me === mi\.deployer \|\| me === mi\.creator_fee_authority/);
  });

  it("feeds isOwnMarket into the ticket's sameOwner state so Open is blocked", () => {
    expect(SRC).toMatch(/sameOwner:\s*ticketLimits\.sameOwner \|\| isOwnMarket/);
  });
});
