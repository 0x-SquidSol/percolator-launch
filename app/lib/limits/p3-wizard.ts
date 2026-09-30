/**
 * Create-market wizard, P3 way (vault-owned LP + junior tranche), in the order the P3 design
 * fixes for binding a market (ledger p3-vault-owned-lp-2026-09-29.md section 0.3):
 *
 *   74 CreateLpVault -> 75 Earn seed deposits      (existing M4a, unchanged)
 *   94 InitVaultLp (path A: the creator is still marketauth, junior owner := creator)
 *   96 DepositJuniorTranche (the creator's first-loss capital)
 *   -- then M4b StakeInitPool, which rotates marketauth away (94 path A is impossible after it)
 *
 * 99 SetVaultLpRisk (approve the matcher, caps, skew) and 95 VaultLpSetMatcher are
 * UPGRADE-AUTHORITY-only (P3-H2), so no browser wizard can run them: until the protocol does,
 * the bound vault LP has no matcher and - with the exclusive-LP rule - the market takes no
 * risk-increasing fills. The wizard says so; see `vaultLpAwaitingProtocol`.
 *
 * Junior requirement: `junior_floor_bps` in 1000..=10000 (the program refuses others), and the
 * junior deposit must at least meet that floor of the senior claim seeded at 94
 * (C = the Earn seed NAV, all harvestable fees 0 on a fresh market), so the first-loss cushion
 * is at its floor from the first Earn deposit on. Pure.
 */
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { BPS, VAULT_LP_MAX_JUNIOR_FLOOR_BPS, VAULT_LP_MIN_JUNIOR_FLOOR_BPS } from "./constants";
import { buildDepositJuniorTrancheIx, buildInitVaultLpIx, type VaultLpMarket } from "./p3-ix";

/** Default floor: 20% of the senior claim (the seed's P3 test markets use 1000-2000). */
export const DEFAULT_JUNIOR_FLOOR_BPS = 2_000;

/** ceil(C * floor / 1e4): the junior the program will not let the creator withdraw below. */
export function juniorFloorAtoms(seniorClaimAtoms: bigint, floorBps: number): bigint {
  return (seniorClaimAtoms * BigInt(floorBps) + (BPS - 1n)) / BPS;
}

export type P3WizardIssue = "floor-out-of-range" | "junior-zero" | "junior-below-floor";

export function validateP3Wizard(p: { juniorFloorBps: number; juniorAtoms: bigint; seedNavAtoms: bigint }): P3WizardIssue | null {
  if (!Number.isInteger(p.juniorFloorBps) || p.juniorFloorBps < VAULT_LP_MIN_JUNIOR_FLOOR_BPS || p.juniorFloorBps > VAULT_LP_MAX_JUNIOR_FLOOR_BPS) {
    return "floor-out-of-range";
  }
  if (p.juniorAtoms <= 0n) return "junior-zero";
  if (p.juniorAtoms < juniorFloorAtoms(p.seedNavAtoms, p.juniorFloorBps)) return "junior-below-floor";
  return null;
}

/**
 * [createAccount(vault LP portfolio, program-owned, portfolio length), 94, 96]. 94 requires the
 * portfolio pre-created exactly like InitPortfolio's, uninitialised.
 */
export function buildP3BindIxs(p: {
  market: VaultLpMarket;
  creator: PublicKey;
  vaultLpPortfolio: PublicKey;
  portfolioLen: number;
  portfolioRentLamports: number;
  juniorFloorBps: number;
  juniorAtoms: bigint;
  creatorAta: PublicKey;
  vaultToken: PublicKey;
}): TransactionInstruction[] {
  if (!p.market.lpPortfolio.equals(p.vaultLpPortfolio)) throw new Error("market.lpPortfolio must be the new vault LP portfolio");
  return [
    SystemProgram.createAccount({
      fromPubkey: p.creator,
      newAccountPubkey: p.vaultLpPortfolio,
      lamports: p.portfolioRentLamports,
      space: p.portfolioLen,
      programId: p.market.programId,
    }),
    buildInitVaultLpIx(p.market, p.creator, p.juniorFloorBps),
    buildDepositJuniorTrancheIx(p.market, p.creator, p.creatorAta, p.vaultToken, p.juniorAtoms),
  ];
}

/** Resume logic for the sequential path: what is still missing on-chain. */
export type P3BindProgress = "bind" | "deposit-junior" | "done";
export function p3BindProgress(state: { exists: boolean; juniorDepositedAtoms: bigint | null }): P3BindProgress {
  if (!state.exists) return "bind";
  if (state.juniorDepositedAtoms === null || state.juniorDepositedAtoms === 0n) return "deposit-junior";
  return "done";
}

/** A bound vault LP whose asset has no approved matcher yet (99 not run by the protocol). */
export function vaultLpAwaitingProtocol(av: { bound: boolean; approvedMatcherProgram: Uint8Array } | null): boolean {
  return !!av && av.bound && av.approvedMatcherProgram.every((b) => b === 0);
}

/** The wizard's `CreateMarketParams.p3`: the Liquidity amount IS the junior tranche. */
export function wizardP3Params(enabled: boolean, lpCollateralAtoms: bigint, juniorFloorBps: number): { juniorFloorBps: number; juniorAtoms: bigint } | undefined {
  if (!enabled) return undefined;
  return { juniorFloorBps, juniorAtoms: lpCollateralAtoms };
}

/** Largest floor the wizard can offer for a junior == lp launch: junior / (2 * seed) of C. */
export function maxWizardFloorBps(juniorAtoms: bigint, seedNavAtoms: bigint): number {
  if (seedNavAtoms <= 0n) return VAULT_LP_MAX_JUNIOR_FLOOR_BPS;
  const bps = (juniorAtoms * BPS) / seedNavAtoms;
  return Number(bps > BigInt(VAULT_LP_MAX_JUNIOR_FLOOR_BPS) ? BigInt(VAULT_LP_MAX_JUNIOR_FLOOR_BPS) : bps);
}
