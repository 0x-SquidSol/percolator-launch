/**
 * Earn / LP-vault "how much has this position earned" — the honest, on-chain-only
 * approximation.
 *
 * WHY THIS IS AN ESTIMATE, NOT AN EXACT FIGURE. The Earn vault genuinely earns
 * trading fees (percolator-stake tag 12 AccrueFees, LP-vault pool_mode), and those
 * fees compound into the share price — there is no separate "claim", withdrawal
 * pays principal + earnings at the current price. So a position's earnings ARE
 * real and realized-on-withdraw. But the per-user on-chain record (StakeDeposit)
 * stores only `lp_amount` and `last_deposit_slot` — NOT the price the shares were
 * minted at (cost basis). A user's TRUE earnings are `value − cost_basis`, and
 * cost basis is not reconstructable from chain state alone.
 *
 * What we CAN compute from chain state is the appreciation of the shares SINCE
 * PAR (share price 1.000000). For a depositor who entered at par this equals
 * their earnings exactly; for someone who entered after fees had already lifted
 * the price it OVERSTATES them (their cost basis was above par). The share price
 * of an LP-vault pool is monotonically non-decreasing (fees only add; losses go
 * to the separate insurance/first-loss pool), so this is an upper bound, never a
 * phantom loss. The exact figure needs the indexer to record each deposit's cost
 * basis — filed separately. Until then this is surfaced clearly LABELLED as an
 * estimate "since par", never as a settled P&L.
 */

/** LP share price at par, e6-scaled (1.000000 collateral per share). */
export const LP_PAR_PRICE_E6 = 1_000_000n;

export interface LpEarnedEstimate {
  /**
   * Estimated collateral atoms earned since par. Always ≥ 0 — clamps below par
   * to zero so a rounding wobble or a legacy sub-par read never renders as a
   * negative "earning".
   */
  earnedAtoms: bigint;
  /** Appreciation over par as a percentage (≥ 0). */
  gainPct: number;
  /** True when the share price is above par, i.e. there is a non-zero estimate. */
  hasGain: boolean;
}

/**
 * @param userValueAtoms the position's current redeemable value in collateral
 *   atoms (userLpBalance × vaultTotalAtoms / lpSupply — the number the card
 *   already shows as "Position Value").
 * @param sharePriceE6 the vault share price, e6-scaled (vaultTotalAtoms / lpSupply),
 *   the SAME basis that produced `userValueAtoms`, so the two are consistent.
 */
export function estimateLpEarnedSincePar(
  userValueAtoms: bigint,
  sharePriceE6: bigint,
): LpEarnedEstimate {
  if (userValueAtoms <= 0n || sharePriceE6 <= LP_PAR_PRICE_E6) {
    return { earnedAtoms: 0n, gainPct: 0, hasGain: false };
  }
  // earned = value − par_cost, where par_cost = value × PAR / price.
  // Rearranged to value × (price − PAR) / price so it stays in bigint and never
  // divides before multiplying.
  const earnedAtoms =
    (userValueAtoms * (sharePriceE6 - LP_PAR_PRICE_E6)) / sharePriceE6;
  // (price − PAR)/PAR × 100, and PAR is 1e6, so the divisor is 10_000.
  const gainPct = Number(sharePriceE6 - LP_PAR_PRICE_E6) / 10_000;
  return { earnedAtoms, gainPct, hasGain: earnedAtoms > 0n };
}
