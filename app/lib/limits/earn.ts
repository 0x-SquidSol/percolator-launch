/**
 * Assemble the P3 Earn tranche view from the limits read model: harvestable fees
 * from the slab (wrapper `lp_vault_harvestable_fee_atoms`), the vault LP's value
 * from its health certificate (wrapper `vault_lp_value_atoms`), and the vault state.
 * Pure; shared by the Earn rail (card + deposit gate) and the creator panel.
 */
import type { MarketLimits } from "@/hooks/useMarketLimits";
import { earnTrancheView, harvestableFeeAtoms, vaultLpValueAtoms, type EarnDepositBlock, type EarnTrancheView, type VaultLpValue } from "./vault-tranche";
import { maxNowAtoms, worseOfLpValue, type EarnSide } from "./earn-withdraw";

export function earnViewFromLimits(
  limits: MarketLimits,
  backingNavAtoms: bigint,
  withdrawShares: bigint,
  /** UX WP-4: price the LP at the worse of effective / target for this side (catch-up). */
  side?: EarnSide,
  /** UX WP-5: the LP value from a simulated crank when the certificate is stale (never guessed). */
  simulatedLpValue?: VaultLpValue | null,
): EarnTrancheView | null {
  const vs = limits.flags.p3 ? limits.vaultState : null;
  const e = limits.engine;
  // The program prices against registry.total_lp_shares_outstanding (tags 75/77), never the
  // LP mint supply. Unread => no view (the gate then does not guess).
  const shares = limits.registryShares;
  if (!vs || !e || shares === null) return null;
  const direct: VaultLpValue = limits.lp ? vaultLpValueAtoms(limits.lp, e) : { kind: "stale" };
  const raw = direct.kind === "stale" && simulatedLpValue ? simulatedLpValue : direct;
  const lpValue = side && limits.lp ? worseOfLpValue(raw, limits.lp.posQ, e.effectivePriceE6, e.targetPriceE6 ?? 0n, side) : raw;
  return earnTrancheView({
    seniorClaimAtoms: vs.seniorClaimAtoms,
    juniorFloorBps: vs.juniorFloorBps,
    seniorFeeShareBps: vs.seniorFeeShareBps,
    backingNavAtoms,
    harvestableAtoms: harvestableFeeAtoms(e),
    lpValue,
    totalShares: shares,
    withdrawShares,
  });
}

/** The share count the Earn gate uses: the registry's, exactly as the program. */
export const earnGateShares = (limits: MarketLimits): bigint | null => limits.registryShares;

/**
 * UX WP-4: the Earn panel's pricing, exactly as the program prices it: registry shares, the senior
 * value at the WORSE of the effective / target price for each side (next wrapper, catch-up rule),
 * and what the vault can pay out now (88 before it happens). null = not a bound P3 vault.
 */
export function earnPanelPricing(
  limits: MarketLimits,
  backingNavAtoms: bigint,
  simulatedLpValue?: VaultLpValue | null,
): { totalShares: bigint; depositSeniorValue: bigint | null; withdrawSeniorValue: bigint | null; maxNowAtoms: bigint | null } | null {
  if (!limits.flags.p3 || !limits.vaultLp?.bound || limits.registryShares === null) return null;
  const dep = earnViewFromLimits(limits, backingNavAtoms, 0n, "deposit", simulatedLpValue);
  const wd = earnViewFromLimits(limits, backingNavAtoms, 0n, "withdraw", simulatedLpValue);
  if (!dep || !wd) return null;
  const lpAtoms = wd.vaultValue !== null ? wd.vaultValue - wd.backingCover : null;
  const drawPending = (limits.vaultState?.seniorDrawOutstandingAtoms ?? 0n) > 0n;
  return {
    totalShares: limits.registryShares,
    depositSeniorValue: dep.senior,
    withdrawSeniorValue: wd.senior,
    maxNowAtoms: maxNowAtoms(wd, lpAtoms, drawPending),
  };
}

/**
 * UX WP-5 (audit §3.6): the only real deposit pause is "covering a loss" (74). A pending-fee
 * genesis (84) and a stale valuation (85) are repaired inside the deposit tx (78 / crank bundled),
 * so they never disable the button.
 */
export function earnDepositPause(block: EarnDepositBlock | null): "senior-impaired" | null {
  return block === "senior-impaired" ? block : null;
}
