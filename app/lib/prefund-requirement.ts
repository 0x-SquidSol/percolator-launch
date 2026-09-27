/**
 * What a market launch costs the creator, and what the devnet faucet therefore
 * has to mint.
 *
 * WHY THIS IS A MODULE AND NOT CONSTANTS IN THE ROUTE
 *
 * This arithmetic had four copies: `/api/devnet-pre-fund`'s local constants,
 * `CreateMarketWizard.tsx`'s launch gate, `createMarketValidation.ts:163` and
 * `CostEstimate.tsx:132`. Three of them drifted.
 *
 * GH#2515 / PR#2516 fixed the wizard gate after it omitted both backing-bucket
 * deposits. That PR touched two files and never reached the route, and on devnet
 * the wizard gate is switched off entirely (`skipTokenBalanceCheck = isDevnet ||
 * mockBypass`), so the route's stale copy became the only guard — and it was
 * understated by exactly the two deposits #2515 was about. GH#2592.
 *
 * The route's tests had a fifth copy, declared as "Mirrors
 * app/api/devnet-pre-fund/route.ts constants", which meant a test suite could
 * stay green while the route it mirrored changed underneath it. It did.
 *
 * So: one definition, imported by the route and by its tests. Server-safe —
 * nothing here is a client module, and no Solana or Supabase dependency.
 */

import { backingSeedPerDomain } from "@/lib/market-params";

/**
 * Minimum seed the program requires at InitMarket.
 * Source of truth: hooks/useCreateMarket.ts → MIN_INIT_MARKET_SEED (a "use
 * client" module, which is why the value is restated here rather than imported).
 * Must also match percolator.rs constants::MIN_INIT_MARKET_SEED.
 */
export const MIN_INIT_MARKET_SEED = 500_000_000n;

/**
 * Amounts assumed when a caller sends none — the reference launch the pre-fund
 * route was originally written around (LP 1,000 / insurance 100 tokens at 6
 * decimals). Kept only so an un-updated caller still gets funded; a caller that
 * sends its real amounts always wins.
 */
export const DEFAULT_LP_COLLATERAL = 1_000_000_000n;
export const DEFAULT_INSURANCE_AMOUNT = 100_000_000n;

/**
 * Ceiling on a fundable launch, expressed as a REQUIREMENT (the mint is 2× it).
 *
 * The caller supplies the amounts that size the mint, so this bounds what a
 * single request can ask the faucet authority for. Exceeding it must be REFUSED,
 * never clamped: funding part-way and reporting success is precisely the defect
 * this module exists to remove.
 */
export const MAX_FUNDABLE_REQUIREMENT = 50_000_000_000n; // 50,000 tokens

/**
 * Total tokens a full market creation draws from the creator's collateral
 * account:
 *
 *   vault seed (MIN_INIT_MARKET_SEED)
 *   + LP collateral
 *   + insurance fund
 *   + ONE backing seed PER DOMAIN   ← TWO deposits, both from the creator
 *
 * `TopUpBackingBucket` runs for both the long and short domain during a launch.
 * At BACKING_SEED_PCT_OF_LP = 100 those two deposits are the largest single term
 * in the total, and their omission is what made a fully-funded wallet unable to
 * finish a launch.
 *
 * Derived from `backingSeedPerDomain` rather than restated: that helper carries
 * the percentage AND the absolute floor (BACKING_SEED_MIN_ATOMS), and the
 * hand-copies in createMarketValidation.ts and CostEstimate.tsx reimplement it
 * in floating-point `Number` and apply no floor at all.
 */
export function fullMarketRequirement(
  lpCollateral: bigint,
  insuranceAmount: bigint,
): bigint {
  return (
    MIN_INIT_MARKET_SEED +
    lpCollateral +
    insuranceAmount +
    2n * backingSeedPerDomain(lpCollateral)
  );
}

/**
 * What the faucet mints, given a requirement.
 *
 * 2× for retry headroom (#757) — and, load-bearing, so the SECOND and THIRD
 * pre-fund calls in a single launch still see a sufficient balance and
 * short-circuit before the 24h per-wallet gate is consulted. That property (H3,
 * GH#2335) only holds while the requirement is correct: understating it is what
 * pushed the step-4 call back into the gate and made it a 429.
 */
export function fundAmountFor(requirement: bigint): bigint {
  return requirement * 2n;
}

/**
 * Parse an optional atomic-unit amount from a request body.
 *
 * Strings of digits only. These amounts size a mint, so a silent `Number()`
 * coercion, a negative, a float or an exponent is not acceptable. Returns
 * `null` for a value that is PRESENT but malformed, so the caller can reject it
 * rather than fall back to a default that would under-fund; returns `fallback`
 * only when the field is genuinely absent.
 */
export function parseAtomicAmount(raw: unknown, fallback: bigint): bigint | null {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string" || !/^[0-9]{1,20}$/.test(raw)) return null;
  return BigInt(raw);
}
