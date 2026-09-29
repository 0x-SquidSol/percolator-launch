/**
 * Assemble the P3 Earn tranche view from the limits read model: harvestable fees
 * from the slab (wrapper `lp_vault_harvestable_fee_atoms`), the vault LP's value
 * from its health certificate (wrapper `vault_lp_value_atoms`), and the vault state.
 * Pure; shared by the Earn rail (card + deposit gate) and the creator panel.
 */
import type { MarketLimits } from "@/hooks/useMarketLimits";
import { earnTrancheView, harvestableFeeAtoms, vaultLpValueAtoms, type EarnTrancheView } from "./vault-tranche";

export function earnViewFromLimits(
  limits: MarketLimits,
  backingNavAtoms: bigint,
  totalShares: bigint,
  withdrawShares: bigint,
): EarnTrancheView | null {
  const vs = limits.flags.p3 ? limits.vaultState : null;
  const e = limits.engine;
  if (!vs || !e) return null;
  const lpValue = limits.lp ? vaultLpValueAtoms(limits.lp, e) : ({ kind: "stale" } as const);
  return earnTrancheView({
    seniorClaimAtoms: vs.seniorClaimAtoms,
    juniorFloorBps: vs.juniorFloorBps,
    seniorFeeShareBps: vs.seniorFeeShareBps,
    backingNavAtoms,
    harvestableAtoms: harvestableFeeAtoms(e),
    lpValue,
    totalShares,
    withdrawShares,
  });
}
