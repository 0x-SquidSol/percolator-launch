/**
 * GET /api/playground/referrals — the caller's own referral link and how many people joined with it.
 *
 * Bound to the signed-in user twice over, so a shared or stale browser never shows someone else's code:
 *   1. the `pg_access` session (HttpOnly, HMAC-signed) carries the code the gate read from the visitor's
 *      own waitlist row, plus `uid`, a keyed tag of the Privy login the gate verified;
 *   2. this request's Privy access token is verified here, and its tag must equal the session's `uid`.
 * Anything short of that (no session, team/judge session, an older session without `uid`, another Privy
 * login) answers `unavailable` and the tab links to the gate's playground page to enter again. The cheap
 * session checks run first, so a request without a usable session never costs a Privy verification.
 *
 * The joined count comes from lib/referral-count.ts (the waitlist's public count endpoint, cached per
 * code). A failed read is `joined: null`, never an error and never 0.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  JUDGE_SUB_PREFIX,
  SESSION_COOKIE,
  TEAM_SUB_PREFIX,
  accessSecret,
  constantTimeEqual,
  privyUserTag,
  readSession,
} from "@/lib/playground-access";
import { verifyPrivyAuth } from "@/lib/privy-auth";
import { referralJoinedCount } from "@/lib/referral-count";
import { referralLink, waitlistOrigin, type ReferralsResponse } from "@/lib/referrals";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

function reply(body: ReferralsResponse): NextResponse {
  return NextResponse.json(body, { headers: NO_STORE });
}

export async function GET(req: NextRequest) {
  const origin = waitlistOrigin();
  const unavailable = () => reply({ status: "unavailable", enterUrl: `${origin}/playground` });

  if (!(req.headers.get("authorization") ?? "").startsWith("Bearer ")) return reply({ status: "signed-out" });

  const secret = accessSecret();
  if (!secret) return unavailable();
  const claims = await readSession(req.cookies.get(SESSION_COOKIE)?.value, secret);
  if (!claims || claims.sub.startsWith(TEAM_SUB_PREFIX) || claims.sub.startsWith(JUDGE_SUB_PREFIX)) return unavailable();
  if (!claims.ref || !claims.uid) return unavailable();

  const auth = await verifyPrivyAuth(req);
  if (!auth.ok) return auth.status === 401 ? reply({ status: "signed-out" }) : unavailable();
  if (!constantTimeEqual(await privyUserTag(auth.userId, secret), claims.uid)) return unavailable();

  return reply({
    status: "ok",
    code: claims.ref,
    link: referralLink(claims.ref, origin),
    joined: await referralJoinedCount(claims.ref, origin),
  });
}
