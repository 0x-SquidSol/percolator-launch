"use client";

import { useEffect, useState } from "react";

/**
 * How long the "authenticated but no usable wallet" state must persist before
 * the UI calls it stale. Privy's Solana `useWallets().ready` already waits for
 * every external connector's silent auto-connect attempt, but the `wallets`
 * array and `ready` flag are separate React state updates — the grace keeps a
 * normal page load from flashing "Reconnect wallet" for one render.
 */
export const RECONNECT_GRACE_MS = 1500;

export interface WalletSessionSignals {
  /** `usePrivy().ready` */
  privyReady: boolean;
  /** `usePrivy().authenticated` — survives reloads via Privy's refresh token. */
  authenticated: boolean;
  /**
   * `useWallets().ready` from `@privy-io/react-auth/solana` (3.41.x): true once
   * every external connector has run its initial silent `standard:connect`
   * (or Privy's 1.5s connector timeout fired) and the user is resolved.
   */
  walletsReady: boolean;
  /** Whether `resolveActiveWallet()` found a wallet that can actually sign. */
  hasActiveWallet: boolean;
}

/**
 * The stale session: Privy still holds a valid session (so `authenticated` is
 * true and `user.wallet` is populated) but no connected Solana wallet was
 * restored — typically an extension that was locked overnight, which rejects
 * Privy's silent reconnect (`standard:connect({ silent: true })`, errors
 * swallowed). In that state nothing can sign, and Privy's `login()` is a no-op.
 */
export function isStaleWalletSession(s: WalletSessionSignals): boolean {
  return s.privyReady && s.authenticated && s.walletsReady && !s.hasActiveWallet;
}

/** `isStaleWalletSession`, debounced by `graceMs` so it never flickers on load. */
export function useWalletNeedsReconnect(
  signals: WalletSessionSignals,
  graceMs: number = RECONNECT_GRACE_MS,
): boolean {
  const stale = isStaleWalletSession(signals);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!stale) {
      setConfirmed(false);
      return;
    }
    const id = setTimeout(() => setConfirmed(true), graceMs);
    return () => clearTimeout(id);
  }, [stale, graceMs]);

  return stale && confirmed;
}
