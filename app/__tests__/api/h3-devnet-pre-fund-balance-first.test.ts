/**
 * H3: /api/devnet-pre-fund must check the on-chain balance BEFORE consuming the
 * 24h per-wallet-per-mint rate gate.
 *
 * All three pre-fund calls inside a single wizard launch (vault seed, LP
 * collateral, insurance top-up — see hooks/useCreateMarket.ts) target the SAME
 * wallet + the SAME shared sim-USDC collateral mint, so they hash to one gate
 * key. Checking the gate before the balance meant the 2nd/3rd call in one flow
 * always collided with the 1st call's still-open 24h claim and 429'd, throwing
 * mid-launch — even though the mint already tops up to 2× the full launch
 * requirement.
 *
 * GH#2592: the requirement and the mint amount now come from
 * lib/prefund-requirement.ts, the same module the route uses. This file used to
 * declare its own copy, labelled "Mirrors app/api/devnet-pre-fund/route.ts
 * constants" — which meant it went on passing after the route's real numbers
 * changed, and its third case asserted "sufficient" at a balance that could not
 * actually fund the launch.
 *
 * We test the ordering in isolation (no live Solana RPC / Supabase needed),
 * mirroring the gate-integration test shape in gh1601-devnet-pre-fund-rate-limit.test.ts.
 */
import { describe, it, expect } from "vitest";

interface GateResult {
  allowed: boolean;
  nextClaimAt: string | null;
  claimId?: number;
}

// The route's OWN definitions — not a copy. A copy is what let this file drift.
import {
  DEFAULT_INSURANCE_AMOUNT,
  DEFAULT_LP_COLLATERAL,
  MIN_INIT_MARKET_SEED,
  fullMarketRequirement,
  fundAmountFor,
} from "@/lib/prefund-requirement";

const FULL_MARKET_TOKEN_REQUIREMENT = fullMarketRequirement(
  DEFAULT_LP_COLLATERAL,
  DEFAULT_INSURANCE_AMOUNT,
);
const FUND_AMOUNT = fundAmountFor(FULL_MARKET_TOKEN_REQUIREMENT);

/** Simulates the post-H3 balance-first flow from devnet-pre-fund/route.ts. */
async function simulatePreFund(
  currentBalance: bigint,
  tryFaucetGate: () => Promise<GateResult>,
  doMint: () => Promise<{ sig: string }>,
): Promise<
  | { status: "sufficient"; balance: string }
  | { status: "funded"; sig: string }
  | { status: "rate_limited"; nextClaimAt: string | null }
> {
  // H3: balance check comes FIRST — the gate is never touched on this path.
  if (currentBalance >= FULL_MARKET_TOKEN_REQUIREMENT) {
    return { status: "sufficient", balance: currentBalance.toString() };
  }

  const gate = await tryFaucetGate();
  if (!gate.allowed) {
    return { status: "rate_limited", nextClaimAt: gate.nextClaimAt };
  }

  const { sig } = await doMint();
  return { status: "funded", sig };
}

describe("H3: devnet-pre-fund balance-first gate ordering", () => {
  it("1st call in a flow (empty wallet): consumes the gate and mints", async () => {
    let gateConsumed = false;
    const tryFaucetGate = async () => {
      gateConsumed = true;
      return { allowed: true, nextClaimAt: null, claimId: 1 };
    };
    const doMint = async () => ({ sig: "SIG_1" });

    const result = await simulatePreFund(0n, tryFaucetGate, doMint);
    expect(result.status).toBe("funded");
    expect(gateConsumed).toBe(true);
  });

  it("2nd call in the same flow (already funded by the 1st): never touches the gate", async () => {
    let gateTouched = false;
    const tryFaucetGate = async () => {
      gateTouched = true;
      // The 1st call's still-open 24h claim — this must NEVER be reached.
      return { allowed: false, nextClaimAt: new Date(Date.now() + 86_400_000).toISOString() };
    };
    const doMint = async () => ({ sig: "SHOULD_NOT_REACH" });

    // Balance already at FUND_AMOUNT (2×) from the 1st call's mint.
    const result = await simulatePreFund(FUND_AMOUNT, tryFaucetGate, doMint);
    expect(result.status).toBe("sufficient");
    expect(gateTouched).toBe(false);
  });

  it("3rd call in the same flow (balance drawn down but still sufficient): still a no-op, no gate", async () => {
    let gateTouched = false;
    const tryFaucetGate = async () => {
      gateTouched = true;
      return { allowed: false, nextClaimAt: new Date().toISOString() };
    };
    const doMint = async () => ({ sig: "SHOULD_NOT_REACH" });

    // Vault seed already spent since the 1st mint — still above the full
    // requirement, which is the property that keeps the later calls out of the
    // gate. Derived from the shared module, so it cannot go on asserting
    // sufficiency at a balance the launch could not actually use (GH#2592).
    const drawnDown = FUND_AMOUNT - MIN_INIT_MARKET_SEED;
    expect(drawnDown).toBeGreaterThanOrEqual(FULL_MARKET_TOKEN_REQUIREMENT);
    const result = await simulatePreFund(drawnDown, tryFaucetGate, doMint);
    expect(result.status).toBe("sufficient");
    expect(gateTouched).toBe(false);
  });

  it("genuinely under-funded AND rate-limited: still 429s (gate stays enforced when it matters)", async () => {
    const tryFaucetGate = async () => ({
      allowed: false,
      nextClaimAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const doMint = async () => ({ sig: "SHOULD_NOT_REACH" });

    const result = await simulatePreFund(0n, tryFaucetGate, doMint);
    expect(result.status).toBe("rate_limited");
  });
});
