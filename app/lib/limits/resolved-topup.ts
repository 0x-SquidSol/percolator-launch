/**
 * Partial resolved payouts (P3 wrapper ordering). A trader whose CloseResolved (30) runs BEFORE
 * the vault LP's 101 VaultLpSettleResolved has finished gets a PARTIAL payout receipt: the rest
 * arrives only through the permissionless tag-46 ClaimResolvedPayoutTopup, and only after the
 * vault LP has settled. No money is lost; it is purely ordering.
 *
 * So the app:
 *   - orders "Finish now" as 101 until final -> 46 (the viewer's own receipt first, then any other
 *     open receipt) -> the rest -> the viewer's 76 (lib/limits/resolved-finish.ts);
 *   - shows one calm line while the viewer's receipt is partial (COPY.resolvedExit.partialReceipt);
 *   - once 101 has closed, bundles the viewer's 46 into their next Earn transaction on that market
 *     (hooks/useInsuranceLP) and puts it first in the settled-market panel's "Finish now".
 * The 46 is sim-gated before it rides along: a refused top-up never costs the user's own tx.
 *
 * "Ready" is the planner's word, not a guess: planResolvedExit emits a claim-topup step for a
 * portfolio only once no vault LP is still materialized and the owners' window has passed.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { ExitPortfolio, ExitStep, ResolvedExitPlan } from "./resolved-exit";

export type ViewerReceipt = "none" | "partial-waiting" | "partial-ready";

const receiptOpen = (p: ExitPortfolio): boolean => p.view.receiptPresent && !p.view.receiptFinalized;

/** Keys of the non-vault portfolios the viewer owns (none without a viewer). */
export function viewerOwnedKeys(portfolios: readonly ExitPortfolio[], viewer: PublicKey | string | null): Set<string> {
  const out = new Set<string>();
  if (!viewer) return out;
  const v = typeof viewer === "string" ? viewer : viewer.toBase58();
  for (const p of portfolios) if (!p.isVaultLp && new PublicKey(p.view.owner).toBase58() === v) out.add(p.key);
  return out;
}

/** The viewer's own claim-topup (46) steps the plan can run NOW (101 has closed). */
export function viewerTopupSteps(plan: ResolvedExitPlan, portfolios: readonly ExitPortfolio[], viewer: PublicKey | string | null): Extract<ExitStep, { kind: "claim-topup" }>[] {
  if (plan.phase !== "sweep") return [];
  const own = viewerOwnedKeys(portfolios, viewer);
  const out: Extract<ExitStep, { kind: "claim-topup" }>[] = [];
  for (const s of plan.steps) if (s.kind === "claim-topup" && own.has(s.portfolio)) out.push(s);
  return out;
}

/** Is the viewer's resolved payout partial, and can the rest be claimed now? */
export function viewerReceiptStatus(plan: ResolvedExitPlan | null, portfolios: readonly ExitPortfolio[], viewer: PublicKey | string | null): ViewerReceipt {
  if (!plan || plan.phase === "not-resolved") return "none";
  const own = viewerOwnedKeys(portfolios, viewer);
  const open = portfolios.some((p) => own.has(p.key) && receiptOpen(p));
  if (!open) return "none";
  return viewerTopupSteps(plan, portfolios, viewer).length > 0 ? "partial-ready" : "partial-waiting";
}

/**
 * Send `base` with a prefix (the viewer's top-up, empty-portfolio closes) in front when there is
 * one. A prefix that makes the tx fail its pre-sign simulation (`isPreSignRefusal`: the wallet
 * never opened) is dropped and the user's own tx is sent alone, so bundling can never cost the
 * user their tx; if that refuses too, the bundled refusal is the one reported.
 */
export async function sendWithTopup<T>(p: {
  topup: readonly TransactionInstruction[];
  base: TransactionInstruction[];
  send: (ixs: TransactionInstruction[], bundled: boolean) => Promise<T>;
  isPreSignRefusal: (e: unknown) => boolean;
}): Promise<T> {
  if (p.topup.length === 0) return p.send(p.base, false);
  let bundledErr: unknown;
  try {
    return await p.send([...p.topup, ...p.base], true);
  } catch (e) {
    if (!p.isPreSignRefusal(e)) throw e;
    bundledErr = e;
  }
  try {
    return await p.send(p.base, false);
  } catch (e) {
    // Both refused before the wallet opened: report the BUNDLED refusal. It is the one that got
    // further (e.g. the closes landed in simulation and the payout then asked for 78 with 84), so
    // a caller's own retry rule (sendWithHarvestOn84) can act on it; the user's tx alone would
    // only say 21 "not terminal-flat".
    if (p.isPreSignRefusal(e)) throw bundledErr;
    throw e;
  }
}
