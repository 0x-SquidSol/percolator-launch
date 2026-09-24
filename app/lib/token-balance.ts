/**
 * Resolving a token balance from a read that may have failed.
 *
 * The Earn and Stake panels re-read the user's token accounts every ~10s.
 * Each read has three distinct outcomes, and only two of them mean "zero":
 *
 *   - the account exists      -> its amount
 *   - the account is absent   -> 0 (the user genuinely holds none)
 *   - the READ FAILED         -> unknown; we hold no evidence either way
 *
 * Collapsing the third case into 0 is what made the balance flicker: on a
 * rate-limited endpoint `getAccountInfo` throws every few polls, the panel
 * rendered `Max: 0 USDC`, and the next successful poll restored the real
 * figure. A wrong number is worse than a stale one — it looks like truth, and
 * here it tells someone their deposit is gone.
 *
 * So a failed read carries the last known figure forward. It is tagged with
 * the account it was read for, because "the last known figure" is only usable
 * if it belongs to the account now being asked about: the wallet can be
 * switched and the slab (so the mint) can be navigated away from, and
 * reporting one account's balance for another would be a worse bug than the
 * flicker. Preserving a balance and knowing whose it is are the same decision,
 * so they are made here rather than re-derived at each call site.
 */

/** Outcome of reading a token account. `ok: false` means the read itself failed. */
export type TokenRead =
  | { ok: true; amount: bigint }
  | { ok: true; absent: true }
  | { ok: false };

/** A balance together with the identity of the account it was read for. */
export type KnownBalance = {
  /**
   * Opaque identity of the token account — see `balanceKey`. `null` means
   * nothing is known yet (no wallet, or no mint resolved).
   */
  key: string | null;
  amount: bigint;
};

export const NO_BALANCE_KNOWN: KnownBalance = { key: null, amount: 0n };

/**
 * Identity of a token account for caching purposes: both the holder and the
 * mint, since either can change under a mounted hook. Returns `null` if either
 * is unknown, which disables the carry-forward rather than guessing.
 */
export function balanceKey(
  owner: string | null | undefined,
  mint: string | null | undefined,
): string | null {
  return owner && mint ? `${owner}:${mint}` : null;
}

export function resolveTokenBalance(
  previous: KnownBalance,
  key: string | null,
  read: TokenRead,
): KnownBalance {
  if (read.ok) {
    // a confirmed-absent account is real evidence of zero, unlike a failed read
    return { key, amount: "absent" in read ? 0n : read.amount };
  }
  // The read failed. Carry the previous figure forward only if it is this
  // account's; otherwise we know nothing and must not invent a number.
  if (key !== null && previous.key === key) return previous;
  return { key, amount: 0n };
}
