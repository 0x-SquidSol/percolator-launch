/**
 * Ordering + search for the Stake page's Insurance Pools list.
 *
 * - Search: keep pools whose `symbol` or `name` contains the query
 *   (case-insensitive; empty query keeps everything).
 * - "My stakes first": a pool the wallet has staked in sorts above the rest,
 *   larger staked value first. Everything else keeps its incoming order via an
 *   explicit index tiebreak (so the result doesn't depend on the JS engine's
 *   sort being stable).
 *
 * Pure and dependency-free so it can be unit-tested in isolation, mirroring
 * `chart-fit.ts`.
 */

export interface StakeOrderable {
  id: string;
  symbol: string;
  name: string;
}

/**
 * @param stakedValueOf returns the wallet's staked value in a pool: `> 0` means
 *   staked (sorts to the top, descending by value); `0` (or negative) means not
 *   staked.
 */
export function orderStakePools<T extends StakeOrderable>(
  pools: readonly T[],
  query: string,
  stakedValueOf: (id: string) => number,
): T[] {
  const q = query.trim().toLowerCase();
  return pools
    .filter(
      (p) =>
        !q ||
        p.symbol.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q),
    )
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const av = stakedValueOf(a.p.id);
      const bv = stakedValueOf(b.p.id);
      const aStaked = av > 0 ? 1 : 0;
      const bStaked = bv > 0 ? 1 : 0;
      if (aStaked !== bStaked) return bStaked - aStaked; // staked pools first
      if (aStaked && bStaked) return bv - av; // larger stake first
      return a.i - b.i; // stable: preserve incoming order otherwise
    })
    .map(({ p }) => p);
}
