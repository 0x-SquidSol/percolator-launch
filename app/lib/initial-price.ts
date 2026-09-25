/**
 * Resolving a market's opening price, and saying why when we can't.
 *
 * The create wizard blocks launch behind `oraclePriceValid`, whose failure
 * message is always "Waiting on price feed". That message was wrong in two
 * different ways, and both of them stranded the user on a spinner with no way
 * forward:
 *
 * 1. THE PRICE RESOLVED, BUT TOO SMALL TO REPRESENT. `initialPriceE6` reaches
 *    the chain as a raw E6 integer with no decimal scaling, so the smallest
 *    non-zero price a market can carry is 1e-6 USD. A token trading below
 *    5e-7 — routine for pump.fun memecoins — rounds to 0, fails the non-zero
 *    gate, and reports a feed problem even though the feed answered correctly.
 *    Nothing the user waits for can ever fix that.
 *
 * 2. A GOOD PRICE WAS OVERWRITTEN WITH NOTHING. Two independent sources feed
 *    this: `/api/oracle/resolve/[mint]` (the wizard's `adminPrice`) and the
 *    DEX pool scan (`config.initialPrice`). The resolve route returns
 *    `price: 0` on a 200 OK when both of its upstreams fail, so `adminPrice`
 *    can be null while the pool price is perfectly good — and the wizard then
 *    assigned the null over it.
 *
 * Hence two exported pieces: one that merges the sources without ever
 * downgrading to nothing, and one that converts to E6 while distinguishing
 * "no price yet" from "this price cannot be represented".
 */

/** The smallest non-zero price an E6 market can carry: 0.000001 USD. */
export const MIN_REPRESENTABLE_PRICE = 1e-6;

export type InitialPriceE6 =
  | { ok: true; e6: bigint }
  /** No usable price yet — waiting on a feed is the correct thing to show. */
  | { ok: false; reason: "missing" }
  /** A real price arrived, but it is below what an E6 market can express. */
  | { ok: false; reason: "below-minimum"; price: number };

/**
 * Merge the available price sources without ever losing a known price.
 *
 * Order is deliberate: the oracle-resolve price is what the keeper will push
 * on-chain, so it wins when present; the pool price is the same token from the
 * other scan and is the right fallback; and anything already held beats
 * replacing a real number with nothing. A later null NEVER downgrades an
 * earlier value — that is the whole point.
 */
export function pickInitialPrice(
  previous: string | null | undefined,
  fromOracle: string | null | undefined,
  fromPool?: string | null | undefined,
): string | null {
  return usable(fromOracle) ?? usable(fromPool) ?? usable(previous) ?? null;
}

function usable(v: string | null | undefined): string | null {
  if (v == null || v === "") return null;
  const n = Number.parseFloat(v);
  // "0.000000" is what a sub-micro price becomes after a 6-dp format. It is
  // not a price, and must not win over a source that still holds the real one.
  return Number.isFinite(n) && n > 0 ? v : null;
}

/**
 * Convert a resolved price to the E6 integer the market is created with,
 * reporting WHY when it cannot be done rather than collapsing to zero.
 */
export function toInitialPriceE6(price: string | null | undefined): InitialPriceE6 {
  if (price == null || price === "") return { ok: false, reason: "missing" };
  const n = Number.parseFloat(price);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "missing" };
  if (n < MIN_REPRESENTABLE_PRICE) return { ok: false, reason: "below-minimum", price: n };
  return { ok: true, e6: BigInt(Math.round(n * 1_000_000)) };
}

/**
 * Format a price for carrying between the hooks and the wizard.
 *
 * NOT `toFixed(6)`: that silently turns every price below 5e-7 into the string
 * "0.000000", which is indistinguishable from "no price" downstream and is
 * exactly how a working feed got reported as a missing one. Keeping full
 * precision lets `toInitialPriceE6` tell the user the real reason.
 */
export function formatResolvedPrice(price: number): string | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  return String(price);
}
