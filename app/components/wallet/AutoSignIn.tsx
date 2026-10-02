"use client";

/**
 * After the waitlist hand-off (/enter → /?signin=1), open the Privy sign-in once so a member
 * signs in with the same email they used on percolator.trade and gets the SAME embedded wallet
 * (same Privy app id). Privy sessions are per domain, so the playground cannot reuse the
 * percolator.trade session — this removes the "connect a wallet again" dead end (2026-10-02).
 */
import { useEffect, useRef } from "react";
import { usePrivyAvailable, usePrivyLogin } from "@/hooks/usePrivySafe";
import { useWalletCompat } from "@/hooks/useWalletCompat";

export const SIGNIN_PARAM = "signin";

export function AutoSignIn() {
  const privyAvailable = usePrivyAvailable();
  const login = usePrivyLogin();
  const { connected } = useWalletCompat();
  const done = useRef(false);

  useEffect(() => {
    if (done.current || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get(SIGNIN_PARAM) !== "1") return;
    done.current = true;
    url.searchParams.delete(SIGNIN_PARAM);
    window.history.replaceState(null, "", url.pathname + (url.search ? url.search : "") + url.hash);
    if (privyAvailable && !connected) login();
  }, [privyAvailable, connected, login]);

  return null;
}
