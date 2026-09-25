/**
 * Turning a token-account read into a balance, without letting a FAILED read
 * masquerade as a CONFIRMED zero.
 *
 * The Earn and Stake panels (useInsuranceLP.ts, useStakePool.ts) re-read the
 * connected wallet's token accounts on a ~10s poll. Each read has three real
 * outcomes, and only two of them mean "the balance is zero":
 *
 *   - the account exists     -> its amount is the balance
 *   - the account is absent  -> 0 is correct; the user genuinely holds none
 *   - the read ITSELF FAILED -> unknown; we have no evidence either way
 *     (RPC timeout, rate limit, transport error, …)
 *
 * The pre-fix code folded the third case into the second: every `catch` around
 * `getAccountInfo` reported 0, so a single rate-limited poll made "Max: 1000
 * USDC" flash to "Max: 0 USDC" and back. That's worse than showing a stale
 * number — it reads as confirmed on-chain truth and disables the deposit
 * control while it's up (GitHub #2545).
 *
 * The fix: a failed read carries the LAST KNOWN balance forward instead of
 * reporting zero. That value is tagged with the exact account it belongs to
 * (owner + mint) so it can never leak across a wallet switch or a market
 * navigation — "the balance I remember" is only valid for the account it was
 * actually read from.
 */

/** The outcome of one attempt to read a token account. `ok: false` means the
 *  read itself failed — it is NOT evidence that the account holds zero. */
export type TokenRead =
  | { ok: true; amount: bigint }
  | { ok: true; absent: true }
  | { ok: false };

/** A balance plus the identity of the token account it came from. */
export interface KnownBalance {
  /** `owner:mint`, or `null` when no account has been identified yet
   *  (wallet not connected, or the mint hasn't resolved). See `balanceKey`. */
  key: string | null;
  amount: bigint;
}

/** The starting state before any read has ever landed. */
export const NO_BALANCE_KNOWN: KnownBalance = { key: null, amount: 0n };

/**
 * Identity of a token account for the carry-forward cache: owner + mint,
 * since a mounted hook can outlive either (wallet switch, market/slab
 * navigation). `null` if either side is unresolved, which disables the
 * carry-forward rather than guessing whose balance it might be.
 */
export function balanceKey(
  owner: string | null | undefined,
  mint: string | null | undefined,
): string | null {
  return owner && mint ? `${owner}:${mint}` : null;
}

/**
 * Fold a `TokenRead` into the next `KnownBalance`, given the previously
 * published one and the identity of the account this read was FOR.
 *
 * - a successful read (present or absent) is always trusted, including a
 *   successful read of zero — a real withdrawal must not be masked by a
 *   stale "last known" figure.
 * - a failed read carries `previous` forward, but ONLY if `previous` was
 *   for the SAME account; otherwise there is nothing to carry (a fresh
 *   wallet/mint with no prior successful read) and the honest answer is 0,
 *   not a guess borrowed from whoever the hook was last showing.
 */
export function resolveTokenBalance(
  previous: KnownBalance,
  key: string | null,
  read: TokenRead,
): KnownBalance {
  if (read.ok) {
    return { key, amount: "absent" in read ? 0n : read.amount };
  }
  if (key !== null && previous.key === key) return previous;
  return { key, amount: 0n };
}
