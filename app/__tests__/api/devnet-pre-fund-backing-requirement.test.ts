/**
 * GH#2592 — the devnet pre-fund requirement must include BOTH backing-bucket
 * deposits, so a wallet the faucet funded can actually finish a launch.
 *
 * The defect: the route costed a launch at a fixed 1,600 tokens, omitting
 * `2 * backingSeedPerDomain(LP)`. `TopUpBackingBucket` runs for both domains,
 * pulling from the creator, so the reference launch really costs 3,100. Any
 * balance in [1,600, 3,100) therefore got a 200 "sufficient" with no mint —
 * including mid-launch, when step 4 had detected the shortfall and was asking
 * the route to fix it. `fundResp4.ok` was true, so the launch carried on and the
 * deposit failed on chain.
 *
 * Devnet sibling of GH#2515 / PR#2516, which fixed the identical arithmetic on
 * the mainnet client gate. That PR touched two files and never reached this
 * route, and on devnet the client gate is off entirely
 * (`skipTokenBalanceCheck = isDevnet || mockBypass`), so the route was the only
 * guard left.
 *
 * NOTE ON 1,600, because it was not simply a stale number: it is the cost of the
 * MOBILE launch (app/api/mobile/create-market), which does transfer a
 * MIN_INIT_MARKET_SEED and seeds no backing. The web flow's W11 fix (2026-07-08)
 * removed the vault-seed transfer, so charging it here over-states by 500 — see
 * lib/prefund-requirement.ts. An earlier version of this fix made exactly that
 * mistake and would have pushed balances in [3,100, 3,600) into the 24h gate.
 *
 * Everything imports lib/prefund-requirement.ts, the definition the route uses.
 * The previous test for this route declared its own copy ("Mirrors
 * app/api/devnet-pre-fund/route.ts constants") and so stayed green while the
 * route was wrong. Route BEHAVIOUR is covered separately, in
 * devnet-pre-fund-route-requirement.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSURANCE_AMOUNT,
  DEFAULT_LP_COLLATERAL,
  MAX_FUNDABLE_REQUIREMENT,
  U64_MAX,
  fullMarketRequirement,
  fundAmountFor,
  fundingRequirement,
  parseAtomicAmount,
} from "@/lib/prefund-requirement";
import { BACKING_SEED_MIN_ATOMS, backingSeedPerDomain } from "@/lib/market-params";

const T = 1_000_000n; // one token at 6 decimals
const LP = 1_000n * T;
const INSURANCE = 100n * T;

/**
 * What the launch actually draws from the creator's token account.
 *
 * Deliberately written from the INSTRUCTIONS, not from the module under test:
 * one LP deposit, one insurance top-up, and one backing top-up per domain. If
 * this and `fullMarketRequirement` ever disagree, the requirement is wrong.
 * There is no vault-seed term — the W11 fix removed that transfer.
 */
function launchSpend(lp: bigint, insurance: bigint): bigint {
  const perDomain = backingSeedPerDomain(lp);
  return lp + insurance + perDomain + perDomain;
}

describe("the requirement equals what a launch actually spends", () => {
  it("is the LP deposit, the insurance, and one backing seed per domain", () => {
    // 1,000 LP + 100 insurance + 2x1,000 backing = 3,100.
    expect(fullMarketRequirement(LP, INSURANCE)).toBe(3_100n * T);
    expect(fullMarketRequirement(LP, INSURANCE)).toBe(launchSpend(LP, INSURANCE));
  });

  it("is NOT the pre-fix 1,600, and NOT 3,600 either", () => {
    // 1,600 was the bug (and is the mobile flow's cost). 3,600 was my own
    // over-correction, charging a vault seed this flow does not transfer.
    expect(fullMarketRequirement(LP, INSURANCE)).not.toBe(1_600n * T);
    expect(fullMarketRequirement(LP, INSURANCE)).not.toBe(3_600n * T);
  });

  it("the backing term is exactly two domains", () => {
    const withoutBacking = LP + INSURANCE;
    expect(fullMarketRequirement(LP, INSURANCE) - withoutBacking).toBe(
      2n * backingSeedPerDomain(LP),
    );
  });

  it("matches the spend at every LP size, not just the default", () => {
    // A fixed constant cannot be right for two LP sizes at once.
    for (const lp of [1n, 10n * T, LP, 3_000n * T]) {
      expect(fullMarketRequirement(lp, INSURANCE)).toBe(launchSpend(lp, INSURANCE));
    }
    expect(fullMarketRequirement(2n * LP, INSURANCE) - fullMarketRequirement(LP, INSURANCE))
      .toBe(3n * LP);
  });

  it("applies the absolute backing floor at tiny LP sizes", () => {
    // backingSeedPerDomain floors at BACKING_SEED_MIN_ATOMS. The hand-copies in
    // createMarketValidation.ts and CostEstimate.tsx compute the percentage in
    // floating-point and skip the floor, which is why this derives from the helper.
    const dust = 1n;
    expect(backingSeedPerDomain(dust)).toBe(BACKING_SEED_MIN_ATOMS);
    expect(fullMarketRequirement(dust, 0n)).toBe(dust + 2n * BACKING_SEED_MIN_ATOMS);
  });
});

describe("a funded wallet can complete the launch it was funded for", () => {
  it("covers the spend with a real cushion left over", () => {
    // THE regression, stated in absolute terms rather than as an inequality
    // between two copies of the same expression: 6,200 funded, 3,100 spent.
    const funded = fundAmountFor(fullMarketRequirement(LP, INSURANCE));
    expect(funded).toBe(6_200n * T);
    expect(funded - launchSpend(LP, INSURANCE)).toBe(3_100n * T);
  });

  it("leaves enough that a SECOND pre-fund call in the same launch short-circuits", () => {
    // H3 / GH#2335: a later call in the same launch must see a sufficient balance,
    // or it collides with the first call's still-open 24h claim and 429s
    // mid-flight. This is the property that fails if the multiplier is dropped.
    const requirement = fullMarketRequirement(LP, INSURANCE);
    const funded = fundAmountFor(requirement);

    // Worst realistic case: LP and both backing seeds already moved, only the
    // insurance top-up left.
    const spentSoFar = LP + 2n * backingSeedPerDomain(LP);
    expect(funded - spentSoFar).toBeGreaterThanOrEqual(requirement);
  });

  it("pins the multiplier exactly, so neither under- nor over-minting passes", () => {
    // `minted === fundAmountFor(...)` cannot catch a change to fundAmountFor,
    // since both sides move together. An absolute value can.
    expect(fundAmountFor(1_000n * T)).toBe(2_000n * T);
  });

  it("CONTROL: an un-updated caller gets the corrected reference launch", () => {
    expect(fullMarketRequirement(DEFAULT_LP_COLLATERAL, DEFAULT_INSURANCE_AMOUNT))
      .toBe(3_100n * T);
  });
});

describe("a request may raise the funding target, never lower it", () => {
  it("a tiny launch is still funded for a default one", () => {
    // SECURITY. The caller does not prove ownership of walletAddress, and the
    // 24h gate key is public. Without this floor, `lpCollateral: "0"` against a
    // victim's wallet burns their 24h claim and mints them an amount too small
    // to launch with — an unauthenticated 24h launch-denial.
    const floor = fullMarketRequirement(DEFAULT_LP_COLLATERAL, DEFAULT_INSURANCE_AMOUNT);
    expect(fundingRequirement(0n, 0n)).toBe(floor);
    expect(fundingRequirement(1n, 1n)).toBe(floor);
    expect(fundingRequirement(10n * T, 0n)).toBe(floor);
  });

  it("a larger launch still raises it", () => {
    // The floor must not flatten real launches, or large-LP creators go back to
    // being under-funded.
    const lp = 3_000n * T;
    expect(fundingRequirement(lp, INSURANCE)).toBe(fullMarketRequirement(lp, INSURANCE));
    expect(fundingRequirement(lp, INSURANCE)).toBeGreaterThan(fundingRequirement(0n, 0n));
  });

  it("CONTROL: exactly the default is unchanged by the floor", () => {
    expect(fundingRequirement(DEFAULT_LP_COLLATERAL, DEFAULT_INSURANCE_AMOUNT))
      .toBe(fullMarketRequirement(DEFAULT_LP_COLLATERAL, DEFAULT_INSURANCE_AMOUNT));
  });
});

describe("the faucet ceiling refuses rather than under-funds", () => {
  it("is pinned to a specific value", () => {
    // Two inequalities alone left this free across a wide band, so the ceiling
    // could be inflated many-fold with no test moving.
    expect(MAX_FUNDABLE_REQUIREMENT).toBe(10_000_000_000n);
  });

  it("a launch above the ceiling is over the limit, not quietly trimmed", () => {
    expect(fullMarketRequirement(100_000n * T, INSURANCE))
      .toBeGreaterThan(MAX_FUNDABLE_REQUIREMENT);
  });

  it("CONTROL: the default and a 3x-default launch are inside it", () => {
    expect(fullMarketRequirement(LP, INSURANCE)).toBeLessThanOrEqual(MAX_FUNDABLE_REQUIREMENT);
    expect(fullMarketRequirement(3_000n * T, INSURANCE)).toBeLessThanOrEqual(MAX_FUNDABLE_REQUIREMENT);
  });
});

describe("amounts that size a mint are parsed strictly", () => {
  it("absent means default", () => {
    expect(parseAtomicAmount(undefined, DEFAULT_LP_COLLATERAL)).toBe(DEFAULT_LP_COLLATERAL);
  });

  it("present and well-formed is used, across the whole accepted range", () => {
    expect(parseAtomicAmount("0", DEFAULT_LP_COLLATERAL)).toBe(0n);
    expect(parseAtomicAmount("2500000000", DEFAULT_LP_COLLATERAL)).toBe(2_500_000_000n);
    // 11 digits — a realistic large launch. Pins the digit bound from BELOW, which
    // nothing did before: narrowing the regex to {1,10} previously went unnoticed.
    expect(parseAtomicAmount("12000000000", DEFAULT_LP_COLLATERAL)).toBe(12_000_000_000n);
    // The largest value the parser accepts at all.
    expect(parseAtomicAmount(U64_MAX.toString(), DEFAULT_LP_COLLATERAL)).toBe(U64_MAX);
  });

  it("rejects anything above u64, since the amount ends up in a u64 mint", () => {
    // Previously the digit bound admitted ~5.4x u64 and only the ceiling check
    // stood in the way — making u64 safety depend on a policy limit.
    expect(parseAtomicAmount((U64_MAX + 1n).toString(), DEFAULT_LP_COLLATERAL)).toBeNull();
    expect(parseAtomicAmount("9".repeat(20), DEFAULT_LP_COLLATERAL)).toBeNull();
  });

  it("present but malformed is rejected, NOT silently defaulted", () => {
    // Defaulting a malformed amount is how a request for a large launch gets
    // funded for a small one and then fails on chain.
    for (const bad of [
      null,            // present, not a string — must not fall back
      "-1", "1.5", "1e9", " 100", "100 ", "", "0x64", "abc",
      1_000_000_000, 1_000_000_000n, {}, [], true,
      "9".repeat(21),  // beyond the digit bound
    ]) {
      expect(parseAtomicAmount(bad, DEFAULT_LP_COLLATERAL)).toBeNull();
    }
  });
});
