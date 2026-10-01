/**
 * "Improve pricing" for an existing market's creator (2026-10-01).
 *
 * The deployed matcher (EDKK 4a0f696) has a units bug in its v1 skew term: any
 * inventory-worsening fill saturates to max_total_bps, so a market that is traded one way quotes
 * the full 200 bps cap. New markets launch with skew 0 (lib/matcher-params.ts); existing ones can
 * drop it with matcher tag 5 Configure, auth mode 1 (owner proof: the LP OWNER signs), op 1
 * SetParams, restating every current parameter with only skew_spread_mult_bps = 0. SetParams
 * preserves inventory, insurance accrual, lp_pda, lp_account_id, backing fee cap and the asset
 * binding (vamm.rs process_configure). Verified by simulation as the creator on both live LPs.
 *
 * Offered only for v1 contexts (no v2 block): restating a v2 config from its decoded STATE is not
 * exact (e.g. warmup-left vs the configured warmup), so a v2 context is never rewritten here.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { buildMatcherConfigureSetParamsIx, zeroMatcherV2Config, type MatcherSetParams } from "@percolatorct/sdk";
import type { MatcherCtxView } from "@/lib/limits/decode";

export const FIX_PRICING_COPY = {
  title: "Improve pricing for traders",
  body: "Your market's quotes widen more than they should after one-sided trading. Fix it with one approval.",
  button: "Improve pricing",
  done: "Pricing improved.",
} as const;

/** The LP owner may fix it: a v1 context whose skew is on. */
export function fixPricingEligible(ctx: MatcherCtxView | null, wallet: PublicKey | null, lpOwner: PublicKey | null): boolean {
  if (!ctx || !wallet || !lpOwner) return false;
  if (ctx.v2 !== null) return false;
  if (ctx.kind !== 0 && ctx.kind !== 1) return false;
  return ctx.skewSpreadMultBps > 0 && wallet.equals(lpOwner);
}

/** Every current parameter restated, skew off. */
export function skewOffSetParams(ctx: MatcherCtxView): MatcherSetParams {
  return {
    kind: ctx.kind as MatcherSetParams["kind"],
    tradingFeeBps: ctx.tradingFeeBps,
    baseSpreadBps: ctx.baseSpreadBps,
    maxTotalBps: ctx.maxTotalBps,
    impactKBps: ctx.impactKBps,
    liquidityNotionalE6: ctx.liquidityNotionalE6,
    maxFillAbs: ctx.maxFillAbs,
    maxInventoryAbs: ctx.maxInventoryAbs,
    feeToInsuranceBps: ctx.feeToInsuranceBps,
    skewSpreadMultBps: 0,
    enableV2: false,
    v2: zeroMatcherV2Config(),
  };
}

export function buildFixPricingIx(a: {
  wrapperProgramId: PublicKey;
  matcherProgramId: PublicKey;
  market: PublicKey;
  lpPortfolio: PublicKey;
  lpOwner: PublicKey;
  matcherCtx: PublicKey;
  ctx: MatcherCtxView;
}): TransactionInstruction {
  return buildMatcherConfigureSetParamsIx(
    {
      wrapperProgramId: a.wrapperProgramId,
      matcherProgramId: a.matcherProgramId,
      market: a.market,
      lpPortfolio: a.lpPortfolio,
      lpOwner: a.lpOwner,
      matcherCtx: a.matcherCtx,
    },
    skewOffSetParams(a.ctx),
  );
}
