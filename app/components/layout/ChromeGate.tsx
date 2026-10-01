"use client";

import { usePathname } from "next/navigation";

/**
 * Hides global chrome (Header, Footer, banners, mobile nav) on routes
 * that ship their own full-screen UI — /waitlist, and /locked (the devnet v2
 * waitlist-lock page, which must show no app content and must not mount
 * components that call the gated /api routes).
 *
 * Used by app/layout.tsx to wrap the persistent layout chrome.  The
 * waitlist page on percolator.trade renders edge-to-edge without the
 * trading-frontend nav around it.
 */
const HIDE_ON = ["/waitlist", "/locked"];

export function ChromeGate({
  children,
  hideOn = HIDE_ON,
}: {
  children: React.ReactNode;
  /** Override the hide list (layout uses ["/locked"] for chrome that /waitlist keeps). */
  hideOn?: readonly string[];
}) {
  const pathname = usePathname();
  if (pathname && hideOn.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return null;
  }
  return <>{children}</>;
}
