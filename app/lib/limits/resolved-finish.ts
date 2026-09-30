/**
 * UX WP-8 (audit §3.9, RX-1): "Finish now" in ONE approval.
 *
 * Every step that can finish the market is planned up front from the decoded portfolios, and the
 * steps the program may need to REPEAT (101 SettleVaultLpResolved, 30 CloseResolved are chunked)
 * are pre-signed in several copies with distinct compute-unit prices (so each copy has its own
 * signature). The whole list is signed with one signAllCompat. The driver then broadcasts in order,
 * re-reading the market before each transaction and skipping any copy whose step is no longer
 * needed — unneeded copies are NEVER broadcast (AC4). The user's own Earn request (76) can ride at
 * the end, so the withdrawal's pending card (WP-4) takes it from there.
 * Pure planning + an injected driver (no RPC here).
 */
import type { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { buildBatchTx } from "@/lib/tx";
import { formatTokenAmount } from "@/lib/format";
import type { ExitPortfolio, ExitStep, ResolvedExitPlan } from "./resolved-exit";
import { exitStepsCu, looksEmpty } from "./resolved-exit";
import { exitStepIxs, type ExitIxContext } from "./resolved-exit-ixs";
import { finishFeeSol } from "./resolved-eta";

/** How many copies of a repeatable step are pre-signed. */
export const FINISH_COPIES = { "settle-vault-lp": 3, "close-resolved": 3 } as const;

export interface FinishItem {
  /** The step this tx runs (a copy repeats the same step). */
  step: ExitStep | { kind: "earn-request" };
  /** 0-based copy index of a repeatable step (0 for single steps). */
  copy: number;
}

const stepKey = (s: FinishItem["step"]): string =>
  s.kind === "earn-request" ? "earn-request" : s.kind === "harvest" ? "harvest" : `${s.kind}:${"portfolio" in s ? s.portfolio : ""}:${s.kind === "settle-vault-lp" ? s.topup : ""}`;

/**
 * The finish list, in the program's order: the vault LP settles first (a winner's close is
 * progress-only until then), then each trader closes (or claims its top-up), then empty
 * portfolios close, then the bound vault harvests, then (optionally) the user's Earn request.
 * Escrowed (NFT) and mid-liquidation portfolios are skipped: nobody but their owner / the engine
 * can move them.
 */
export function buildFinishList(input: {
  portfolios: readonly ExitPortfolio[];
  boundVault: boolean;
  withEarnRequest: boolean;
  /** Owners' window: only these portfolios can be touched now (the plan's own steps). */
  only?: ReadonlySet<string>;
}): FinishItem[] {
  const out: FinishItem[] = [];
  const pick = (p: ExitPortfolio) => !input.only || input.only.has(p.key);
  const vault = input.portfolios.filter((p) => p.isVaultLp && pick(p));
  const traders = input.portfolios.filter((p) => !p.isVaultLp && pick(p) && !p.escrowed && !p.view.rebalanceLock && !p.view.liquidationLock);
  for (const v of vault) {
    if (looksEmpty(v.view)) continue;
    for (let c = 0; c < FINISH_COPIES["settle-vault-lp"]; c++) out.push({ step: { kind: "settle-vault-lp", topup: 0, portfolio: v.key }, copy: c });
    out.push({ step: { kind: "settle-vault-lp", topup: 1, portfolio: v.key }, copy: 0 });
  }
  for (const t of traders) {
    if (looksEmpty(t.view)) continue;
    for (let c = 0; c < FINISH_COPIES["close-resolved"]; c++) out.push({ step: { kind: "close-resolved", portfolio: t.key }, copy: c });
    out.push({ step: { kind: "claim-topup", portfolio: t.key }, copy: 0 });
  }
  for (const p of [...vault, ...traders]) out.push({ step: { kind: "close-empty", portfolio: p.key, isVaultLp: p.isVaultLp }, copy: 0 });
  if (input.boundVault) out.push({ step: { kind: "harvest" }, copy: 0 });
  if (input.withEarnRequest) out.push({ step: { kind: "earn-request" }, copy: 0 });
  return out;
}

/** The portfolios a plan touches now (for `only` during the owners' window). */
export function planPortfolios(plan: ResolvedExitPlan): Set<string> {
  const out = new Set<string>();
  if (plan.phase === "sweep" || plan.phase === "owner-window") for (const s of plan.steps) if ("portfolio" in s) out.add(s.portfolio);
  return out;
}

/** Compute budget of one finish tx (one step per tx, so skipping a copy is exact). */
export const EARN_REQUEST_CU = 60_000;
export const finishItemCu = (item: FinishItem): number => (item.step.kind === "earn-request" ? EARN_REQUEST_CU : exitStepsCu([item.step]));

/** Instructions for one finish item; the Earn request is built by the caller (lib/limits/earn-ixs buildRequestRedeemIx). */
export function finishItemIxs(item: FinishItem, ctx: ExitIxContext, earnRequest: TransactionInstruction | null): TransactionInstruction[] {
  if (item.step.kind === "earn-request") {
    if (!earnRequest) throw new Error("earn-request item without the request instruction");
    return [earnRequest];
  }
  return exitStepIxs(item.step, ctx);
}

/**
 * Most transactions one "Finish now" asks the wallet to sign. One blockhash lives ~60-90 s and
 * each broadcast is confirmed before the next, so a longer list would expire mid-run anyway; the
 * keeper finishes whatever is left.
 */
export const FINISH_MAX_TXS = 24;

/** Is this item's step still needed, per a fresh plan? */
export function stepNeeded(item: FinishItem, plan: ResolvedExitPlan): boolean {
  if (item.step.kind === "earn-request") return plan.phase === "ready";
  if (plan.phase === "ready" || plan.phase === "not-resolved") return false;
  const k = stepKey(item.step);
  return plan.steps.some((s) => stepKey(s) === k);
}

export interface FinishDriverDeps<Tx> {
  plan: () => Promise<ResolvedExitPlan>;
  broadcast: (tx: Tx) => Promise<string>;
}

export interface FinishRun {
  broadcast: number;
  skipped: number;
  failed: number;
  signatures: string[];
  final: ResolvedExitPlan;
  /** The pre-signed list stopped being usable (e.g. its blockhash expired). */
  stale: boolean;
  /** The user's own Earn request (76) was broadcast and landed. */
  requested: boolean;
}

/**
 * Broadcast the pre-signed list in order, re-planning before each item and skipping any item not
 * needed. A failed copy does not stop later steps; an expired blockhash stops the run (the regular
 * sweep picks up the rest).
 */
export async function runFinish<Tx>(items: readonly { item: FinishItem; tx: Tx }[], d: FinishDriverDeps<Tx>): Promise<FinishRun> {
  const signatures: string[] = [];
  let skipped = 0;
  let failed = 0;
  let stale = false;
  let requested = false;
  let plan = await d.plan();
  for (const { item, tx } of items) {
    if (!stepNeeded(item, plan)) {
      skipped++;
      continue;
    }
    try {
      signatures.push(await d.broadcast(tx));
      if (item.step.kind === "earn-request") requested = true;
    } catch (e) {
      failed++;
      if (/blockhash not found|block height exceeded|expired/i.test(e instanceof Error ? e.message : String(e))) {
        stale = true;
        break;
      }
    }
    plan = await d.plan();
  }
  if (stale) plan = await d.plan();
  return { broadcast: signatures.length, skipped, failed, signatures, final: plan, stale, requested };
}

/** What "Finish now" would do: distinct steps (copies not counted) and the fee estimate. */
export function finishEstimate(items: readonly FinishItem[]): { steps: number; sol: string } {
  const firsts = items.filter((i) => i.copy === 0 && i.step.kind !== "earn-request");
  const payoutAccounts = firsts.filter((i) => i.step.kind === "close-resolved" || (i.step.kind === "settle-vault-lp" && i.step.topup === 0)).length;
  const txs = items.filter((i) => i.step.kind !== "earn-request").length;
  return { steps: firsts.length, sol: finishFeeSol({ txs, payoutAccounts }) };
}

/**
 * One unsigned tx per item, all on one blockhash. Each tx gets a DISTINCT compute-unit price
 * (base + index + 1): two copies of one step would otherwise be byte-identical, share a signature,
 * and the second would be dropped as a duplicate.
 */
export function buildFinishTxs(
  items: readonly FinishItem[],
  ctx: ExitIxContext,
  earnRequest: TransactionInstruction | null,
  o: { blockhash: string; priorityFeeMicroLamports: number; feePayer: PublicKey },
): Transaction[] {
  return items.map((it, i) =>
    buildBatchTx({
      instructions: finishItemIxs(it, ctx, earnRequest),
      computeUnits: finishItemCu(it),
      priorityFeeMicroLamports: o.priorityFeeMicroLamports + i + 1,
      blockhash: o.blockhash,
      feePayer: o.feePayer,
    }),
  );
}

/**
 * What the settled-market panel shows for the viewer's own Earn position: the amount in the ETA
 * line, and the shares "Finish now" may request (none while a request is already pending: WP-4's
 * pending card owns that withdrawal).
 */
export function earnExitProps(
  s: { userLpBalance: bigint; userRedeemableValue: bigint; pendingRedemptionShares: bigint },
  decimals: number,
  symbol: string,
): { earnAmount: string | null; requestableShares: bigint } {
  if (s.userLpBalance <= 0n) return { earnAmount: null, requestableShares: 0n };
  return {
    earnAmount: `${formatTokenAmount(s.userRedeemableValue, decimals, 2)} ${symbol}`,
    requestableShares: s.pendingRedemptionShares > 0n ? 0n : s.userLpBalance,
  };
}
