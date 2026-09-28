/**
 * Filtering + ordering for the Earn page's "Active Vaults" grid.
 *
 * Order of operations:
 *  1. Hide markets with no usable on-chain Earn vault (`hasVault === false`) —
 *     a market you can't deposit into isn't an "active vault". `undefined`
 *     (mock/fallback rows) is treated as present.
 *  2. If `mineOnly`, keep only markets the wallet has a deposit in (> 0).
 *  3. Search by `symbol`/`name` (case-insensitive; empty keeps everything).
 *  4. Sort: the wallet's own deposits float to the top (by amount, desc), then
 *     the rest by the chosen key (tvl/volume/utilization). An explicit index
 *     tiebreak keeps ties in incoming order regardless of engine sort stability.
 *
 * Pure and dependency-free so it can be unit-tested in isolation (mirrors
 * chart-fit.ts / stake-pool-order.ts).
 */

export type EarnSortKey = "tvl" | "volume" | "utilization";

export interface EarnOrderable {
  slabAddress: string;
  symbol: string;
  name: string;
  vaultBalance: number;
  volume24h: number;
  oiUtilPct: number;
  /** undefined = treat as present; only an explicit false is hidden. */
  hasVault?: boolean;
}

export interface EarnOrderOptions {
  query: string;
  sortBy: EarnSortKey;
  /** When true, show only markets the wallet has a deposit in. */
  mineOnly: boolean;
  /** Wallet's deposit in a market, in USD. `0` = not deposited. */
  depositOf: (slabAddress: string) => number;
}

function sortValue(m: EarnOrderable, key: EarnSortKey): number {
  return key === "tvl" ? m.vaultBalance : key === "volume" ? m.volume24h : m.oiUtilPct;
}

export function orderEarnVaults<T extends EarnOrderable>(
  markets: readonly T[],
  opts: EarnOrderOptions,
): T[] {
  const q = opts.query.trim().toLowerCase();
  return markets
    .filter((m) => m.hasVault !== false)
    .filter((m) => !opts.mineOnly || opts.depositOf(m.slabAddress) > 0)
    .filter(
      (m) =>
        !q ||
        m.symbol.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q),
    )
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ad = opts.depositOf(a.m.slabAddress);
      const bd = opts.depositOf(b.m.slabAddress);
      const aMine = ad > 0 ? 1 : 0;
      const bMine = bd > 0 ? 1 : 0;
      if (aMine !== bMine) return bMine - aMine; // your deposits first
      if (aMine && bMine && ad !== bd) return bd - ad; // larger deposit first
      const s = sortValue(b.m, opts.sortBy) - sortValue(a.m, opts.sortBy);
      if (s !== 0) return s;
      return a.i - b.i; // stable: preserve incoming order on a tie
    })
    .map(({ m }) => m);
}
