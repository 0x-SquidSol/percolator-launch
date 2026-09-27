/**
 * GH#2592 — the devnet pre-fund requirement must include BOTH backing-bucket
 * deposits, so a wallet the faucet funded can actually finish a launch.
 *
 * The defect: the route costed a launch as vault seed + LP + insurance = 1,600
 * tokens, omitting `2 × backingSeedPerDomain(LP)`. `TopUpBackingBucket` runs for
 * both domains, pulling from the creator, so the real cost of that same launch
 * is 3,600. Two things followed:
 *
 *   - a fully-funded fresh wallet (2 × 1,600 = 3,200) was 400 tokens short
 *     before it started; and
 *   - mid-launch, when step 4 detected the shortfall and asked the route to top
 *     up, the route compared against its stale 1,600 and answered 200
 *     "sufficient" with no mint. `fundResp4.ok` was true, so the launch carried
 *     on and the deposit failed on chain.
 *
 * This is the devnet sibling of GH#2515 / PR#2516, which fixed the identical
 * arithmetic on the mainnet client gate. That PR changed two files and never
 * reached this route — and on devnet the client gate is off entirely
 * (`skipTokenBalanceCheck = isDevnet || mockBypass`), so the route was the only
 * guard left.
 *
 * Everything here imports lib/prefund-requirement.ts, the single definition the
 * route itself uses. The previous test for this route declared its own copy
 * ("Mirrors app/api/devnet-pre-fund/route.ts constants") and therefore stayed
 * green while the route changed underneath it.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSURANCE_AMOUNT,
  DEFAULT_LP_COLLATERAL,
  MAX_FUNDABLE_REQUIREMENT,
  MIN_INIT_MARKET_SEED,
  fullMarketRequirement,
  fundAmountFor,
  parseAtomicAmount,
} from "@/lib/prefund-requirement";
import { BACKING_SEED_MIN_ATOMS, backingSeedPerDomain } from "@/lib/market-params";

const T = 1_000_000n; // one token at 6 decimals
const LP = 1_000n * T;
const INSURANCE = 100n * T;

/** The launch's own step-4 predicate, from useCreateMarket.ts. */
function tx4Required(lp: bigint, insurance: bigint): bigint {
  return lp + insurance + 2n * backingSeedPerDomain(lp);
}

describe("the requirement covers what a launch actually spends", () => {
  it("includes both backing seeds, not just LP and insurance", () => {
    // 500 vault + 1,000 LP + 100 insurance + 2×1,000 backing = 3,600.
    expect(fullMarketRequirement(LP, INSURANCE)).toBe(3_600n * T);

    // The pre-fix value, named so a regression is unambiguous rather than
    // showing up as an arithmetic surprise.
    expect(fullMarketRequirement(LP, INSURANCE)).not.toBe(1_600n * T);
  });

  it("the backing term is exactly two domains", () => {
    // One domain, or a single seed, are the two plausible wrong answers.
    const withoutBacking = MIN_INIT_MARKET_SEED + LP + INSURANCE;
    expect(fullMarketRequirement(LP, INSURANCE) - withoutBacking).toBe(
      2n * backingSeedPerDomain(LP),
    );
  });

  it("scales with LP rather than assuming one reference launch", () => {
    // A fixed constant cannot be right for more than one LP size. The
    // requirement grows as 3×LP + insurance + vault seed.
    const small = fullMarketRequirement(10n * T, INSURANCE);
    const large = fullMarketRequirement(10_000n * T, INSURANCE);
    expect(large).toBeGreaterThan(small);
    expect(fullMarketRequirement(2n * LP, INSURANCE) - fullMarketRequirement(LP, INSURANCE))
      .toBe(3n * LP);
  });

  it("applies the absolute backing floor at tiny LP sizes", () => {
    // backingSeedPerDomain floors at BACKING_SEED_MIN_ATOMS. The hand-copies in
    // createMarketValidation.ts and CostEstimate.tsx compute the percentage in
    // floating-point and skip the floor, which is why this is derived from the
    // helper rather than restated.
    const dust = 1n;
    expect(backingSeedPerDomain(dust)).toBe(BACKING_SEED_MIN_ATOMS);
    expect(fullMarketRequirement(dust, 0n)).toBe(
      MIN_INIT_MARKET_SEED + dust + 2n * BACKING_SEED_MIN_ATOMS,
    );
  });
});

describe("a funded wallet can complete the launch it was funded for", () => {
  it("survives the vault-seed spend and still covers step 4", () => {
    // THE regression. Pre-fix: funded 3,200, spent 500, left 2,700, step 4
    // needed 3,100 — short by 400 with no way to top up.
    const requirement = fullMarketRequirement(LP, INSURANCE);
    const funded = fundAmountFor(requirement);

    const afterVaultSeed = funded - MIN_INIT_MARKET_SEED;
    expect(afterVaultSeed).toBeGreaterThanOrEqual(tx4Required(LP, INSURANCE));
  });

  it("holds across LP sizes, not just the default", () => {
    for (const lp of [1n, 10n * T, LP, 5_000n * T, 12_000n * T]) {
      const requirement = fullMarketRequirement(lp, INSURANCE);
      const afterVaultSeed = fundAmountFor(requirement) - MIN_INIT_MARKET_SEED;
      expect(afterVaultSeed).toBeGreaterThanOrEqual(tx4Required(lp, INSURANCE));
    }
  });

  it("funds enough that later calls short-circuit before the 24h gate", () => {
    // H3 / GH#2335: a launch calls this route up to 3× for the same wallet and
    // mint. Those later calls must see a sufficient balance, or they collide
    // with the first call's still-open claim and 429 mid-launch. That property
    // depends on the requirement being right, which is what broke it.
    const requirement = fullMarketRequirement(LP, INSURANCE);
    expect(fundAmountFor(requirement)).toBeGreaterThanOrEqual(requirement);

    // Worst case: everything except the final insurance top-up already spent.
    const spent = MIN_INIT_MARKET_SEED + LP + 2n * backingSeedPerDomain(LP);
    expect(fundAmountFor(requirement) - spent).toBeGreaterThanOrEqual(INSURANCE);
  });

  it("CONTROL: an un-updated caller gets the corrected reference launch", () => {
    // Callers that send no amounts fall back to the documented defaults, now
    // costed correctly rather than at 1,600.
    expect(fullMarketRequirement(DEFAULT_LP_COLLATERAL, DEFAULT_INSURANCE_AMOUNT))
      .toBe(3_600n * T);
  });
});

describe("the faucet ceiling refuses rather than under-funds", () => {
  it("a launch above the ceiling is over the limit, not quietly trimmed", () => {
    // The route 400s on this. Clamping to the ceiling would fund part-way and
    // answer 200 — the exact defect being fixed.
    const huge = fullMarketRequirement(100_000n * T, INSURANCE);
    expect(huge).toBeGreaterThan(MAX_FUNDABLE_REQUIREMENT);
  });

  it("CONTROL: a normal launch is comfortably inside the ceiling", () => {
    expect(fullMarketRequirement(LP, INSURANCE)).toBeLessThanOrEqual(MAX_FUNDABLE_REQUIREMENT);
  });
});

describe("amounts that size a mint are parsed strictly", () => {
  it("absent means default", () => {
    expect(parseAtomicAmount(undefined, DEFAULT_LP_COLLATERAL)).toBe(DEFAULT_LP_COLLATERAL);
    expect(parseAtomicAmount(null, DEFAULT_LP_COLLATERAL)).toBe(DEFAULT_LP_COLLATERAL);
  });

  it("present and well-formed is used", () => {
    expect(parseAtomicAmount("2500000000", DEFAULT_LP_COLLATERAL)).toBe(2_500_000_000n);
    expect(parseAtomicAmount("0", DEFAULT_LP_COLLATERAL)).toBe(0n);
  });

  it("present but malformed is rejected, NOT silently defaulted", () => {
    // Defaulting a malformed amount is how a request for a large launch would
    // get funded for a small one and then fail on chain.
    for (const bad of [
      "-1",            // negative
      "1.5",           // float
      "1e9",           // exponent
      " 100",          // padded
      "100 ",
      "",              // empty
      "0x64",          // hex
      "abc",
      1_000_000_000,   // a number, not a string
      1_000_000_000n,  // a bigint, not a string
      {},
      [],
      true,
      "9".repeat(21),  // beyond the digit bound
    ]) {
      expect(parseAtomicAmount(bad, DEFAULT_LP_COLLATERAL)).toBeNull();
    }
  });
});
