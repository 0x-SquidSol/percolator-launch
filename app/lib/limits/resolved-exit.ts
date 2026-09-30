/**
 * Earn senior exit after a market RESOLVES (P3 424fe7e4; F-4 + P3-H1 + F-8).
 *
 * ExecuteRedemption (77) in Resolved mode needs a TERMINAL-FLAT market:
 * `materialized_portfolio_count == 0 && c_tot == 0` (`handle_execute_redemption`, #377). One
 * walked-away trader used to lock every Earn depositor (F-4). The program now lets ANYONE
 * finish the market, and this module plans that sweep from decoded state:
 *
 *   vault LP (bound):  101 VaultLpSettleResolved(0) [+ 101(1) while its payout receipt is
 *                      unfinalized]  ->  8 ClosePortfolio with owner = registry PDA
 *   each trader:       30 CloseResolved (permissionless after force_close_delay_slots; pays the
 *                      OWNER's ATA)  ->  46 top-up while its receipt is unfinalized  ->
 *                      8 ClosePortfolio (F-4: any signer, rent to the owner)
 *
 * The vault LP goes first: a winning trader's resolved close is progress-only until its losing
 * counterparty (the vault LP) has settled (P3 final pass). The emptiness test here is the
 * subset of the engine's `is_empty_for_dematerialization` the app can decode; close-progress
 * and source-domain slots are not decoded, so every step is simulated before it is sent and a
 * refused step is reported, never retried blindly.
 *
 * Pure: no RPC. `useResolvedExit` feeds it and executes the plan.
 */
import { MARKET_MODE_RESOLVED } from "./constants";
import type { ResolvedMarketView, ResolvedPortfolioView } from "./decode";

export interface ExitPortfolio {
  /** base58 key (the planner never builds keys). */
  key: string;
  view: ResolvedPortfolioView;
  /** The owner is an off-curve PDA that is not this market's LP-vault registry => most likely
   *  NFT-escrowed: an unsigned 30/46 is refused (GH#496), its holder must act. */
  escrowed: boolean;
  isVaultLp: boolean;
}

export type ExitStep =
  /** 07a1d0eb: tag 78 on a BOUND vault once the market is terminal-flat (fees -> backing + C). */
  | { kind: "harvest" }
  | { kind: "settle-vault-lp"; topup: 0 | 1; portfolio: string }
  | { kind: "close-resolved"; portfolio: string }
  | { kind: "claim-topup"; portfolio: string }
  | { kind: "close-empty"; portfolio: string; isVaultLp: boolean };

export type ExitBlocker =
  | { kind: "escrowed"; portfolio: string }
  | { kind: "locked"; portfolio: string };

export type ResolvedExitPlan =
  | { phase: "not-resolved" }
  /** Live-mode resolve not done; or the owner-only window: trader/vault closes need their owner until `untilSlot`. */
  | { phase: "owner-window"; untilSlot: bigint; steps: ExitStep[]; blockers: ExitBlocker[] }
  | { phase: "sweep"; steps: ExitStep[]; blockers: ExitBlocker[] }
  /** Terminal-flat: the Earn redemption (76 -> 77) can run now. */
  | { phase: "ready"; blockers: ExitBlocker[] };

/** Decodable subset of the engine's `is_empty_for_dematerialization`. */
export function looksEmpty(p: ResolvedPortfolioView): boolean {
  return (
    p.activeBitmap === 0n &&
    p.capital === 0n &&
    p.pnl === 0n &&
    p.reservedPnl === 0n &&
    p.feeCredits === 0n &&
    p.cancelDepositEscrow === 0n &&
    !p.stale &&
    !p.bStale &&
    !p.rebalanceLock &&
    !p.liquidationLock &&
    (!p.receiptPresent || p.receiptFinalized)
  );
}

const receiptOpen = (p: ResolvedPortfolioView): boolean => p.receiptPresent && !p.receiptFinalized;

/** End of the owner-only window (tag 30 / the 101 close step): `resolved_slot + delay`. */
export function ownerWindowEnd(m: ResolvedMarketView): bigint {
  return m.forceCloseDelaySlots === 0n ? 0n : m.resolvedSlot + m.forceCloseDelaySlots;
}

/**
 * Plan the next steps. `nowSlot` is the chain slot (the program admits the authenticated Clock
 * into the resolved clock). `harvestableAtoms` is `lp_vault_harvestable_fee_atoms`: a bound
 * vault's 77 refuses 84 while it is non-zero; since 07a1d0eb tag 78 runs on a Resolved bound
 * vault once TERMINAL-FLAT, so the sweep ends with a "harvest" step (then the redemption pays).
 */
export function planResolvedExit(input: {
  market: ResolvedMarketView;
  nowSlot: bigint;
  portfolios: readonly ExitPortfolio[];
  boundVault: boolean;
  harvestableAtoms: bigint | null;
  /** F-14 claim-free residual (decodeTerminalBacking); 78 absorbs it at terminal-flat. */
  terminalResidualAtoms?: bigint | null;
}): ResolvedExitPlan {
  const { market, nowSlot, portfolios, boundVault, harvestableAtoms } = input;
  const residual = input.terminalResidualAtoms ?? 0n;
  if (market.mode !== MARKET_MODE_RESOLVED) return { phase: "not-resolved" };
  const blockers: ExitBlocker[] = [];

  const windowEnd = ownerWindowEnd(market);
  const inWindow = nowSlot < windowEnd;
  const steps: ExitStep[] = [];
  const vault = portfolios.filter((p) => p.isVaultLp);
  const traders = portfolios.filter((p) => !p.isVaultLp);

  for (const v of vault) {
    if (looksEmpty(v.view)) steps.push({ kind: "close-empty", portfolio: v.key, isVaultLp: true });
    else if (receiptOpen(v.view)) steps.push({ kind: "settle-vault-lp", topup: 1, portfolio: v.key });
    else if (!inWindow) steps.push({ kind: "settle-vault-lp", topup: 0, portfolio: v.key });
  }
  // A winning trader is progress-only until the vault LP has settled: plan traders only once no
  // vault LP remains materialized (the next round picks them up).
  const vaultPending = vault.some((v) => !looksEmpty(v.view));
  for (const t of traders) {
    if (looksEmpty(t.view)) {
      steps.push({ kind: "close-empty", portfolio: t.key, isVaultLp: false });
      continue;
    }
    if (t.escrowed) {
      blockers.push({ kind: "escrowed", portfolio: t.key });
      continue;
    }
    if (t.view.rebalanceLock || t.view.liquidationLock) {
      blockers.push({ kind: "locked", portfolio: t.key });
      continue;
    }
    if (vaultPending || inWindow) continue;
    steps.push(receiptOpen(t.view) ? { kind: "claim-topup", portfolio: t.key } : { kind: "close-resolved", portfolio: t.key });
  }

  const terminalFlat = market.materializedPortfolioCount === 0n && market.cTot === 0n;
  // F-14: 78 on a terminal-flat Resolved bound market harvests pending fees AND absorbs the
  // claim-free residual; 77 refuses 84 until it has run. (78 with neither fails NoFeesToCrank.)
  if (terminalFlat && boundVault && ((harvestableAtoms !== null && harvestableAtoms > 0n) || residual > 0n)) {
    return { phase: "sweep", steps: [{ kind: "harvest" }], blockers };
  }
  if (terminalFlat) return { phase: "ready", blockers };
  if (inWindow) return { phase: "owner-window", untilSlot: windowEnd, steps, blockers };
  return { phase: "sweep", steps, blockers };
}

/** Group steps into transactions: at most `perTx` portfolio steps each (payout ATAs are created
 *  idempotently in front, so a close-resolved costs ~4 accounts). Order is preserved. */
export function batchExitSteps(steps: readonly ExitStep[], perTx = 3): ExitStep[][] {
  const out: ExitStep[][] = [];
  for (let i = 0; i < steps.length; i += perTx) out.push(steps.slice(i, i + perTx));
  return out;
}

/** What the Earn panel says about a resolved market (pure; copy in ./copy). */
export interface ResolvedExitSummary {
  phase: ResolvedExitPlan["phase"];
  /** Steps anyone can run right now (the button is enabled iff > 0). */
  runnable: number;
  untilSlot: bigint | null;
  escrowed: number;
  locked: number;
}

export function summarizeResolvedExit(plan: ResolvedExitPlan): ResolvedExitSummary {
  if (plan.phase === "not-resolved") return { phase: plan.phase, runnable: 0, untilSlot: null, escrowed: 0, locked: 0 };
  const steps = plan.phase === "ready" ? [] : plan.steps;
  return {
    phase: plan.phase,
    runnable: steps.length,
    untilSlot: plan.phase === "owner-window" ? plan.untilSlot : null,
    escrowed: plan.blockers.filter((b) => b.kind === "escrowed").length,
    locked: plan.blockers.filter((b) => b.kind === "locked").length,
  };
}
