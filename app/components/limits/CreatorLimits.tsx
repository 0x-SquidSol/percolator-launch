"use client";

/**
 * Creator surfaces for the limits (plan §2 "Creator"):
 *   - WizardTranchePanel: the wizard's liquidity amount becomes the JUNIOR
 *     (first-loss) tranche under P3; shows the requirement and the caps that
 *     capital projects to (P1 LP exposure cap = junior × k; the most Earn
 *     capital the 10% protocol floor allows = junior / floor).
 *   - CreatorTranchePanel: my-markets drawer — junior at risk, cushion,
 *     withdrawable now, creator fees earned, live caps.
 * Flag-gated (P3 for tranche rows, P1 for caps). Pure math in lib/limits.
 */
import { type FC } from "react";
import { useMarketLimits, type MarketLimits } from "@/hooks/useMarketLimits";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useInsuranceLP } from "@/hooks/useInsuranceLP";
import { limitsFlags } from "@/lib/limits/flags";
import { COPY } from "@/lib/limits/copy";
import { VAULT_LP_MIN_JUNIOR_FLOOR_BPS } from "@/lib/limits/constants";
import { defaultLpExposureKBps, lpEquityInitRaw, lpExposureCapQ, maxTradeSizePerSide, nonnegEquity, effectiveLpExposureKBps } from "@/lib/limits/risk-limits";
import { juniorWithdrawableAtoms, projectCreatorCaps } from "@/lib/limits/vault-tranche";
import { earnViewFromLimits } from "@/lib/limits/earn";
import { formatTokenAmount } from "@/lib/format";
import { LimitsNotice, LimitsRow } from "./LimitsRow";
import { fmtQ } from "./OrderTicketLimits";

export const WizardTranchePanel: FC<{
  juniorUnits: number;
  initialMarginBps: number;
  decimals: number;
  collateralSymbol: string;
}> = ({ juniorUnits, initialMarginBps, decimals, collateralSymbol }) => {
  if (!limitsFlags().p3) return null;
  const j = BigInt(Math.max(0, Math.floor(juniorUnits * 10 ** decimals)));
  const k = defaultLpExposureKBps(BigInt(initialMarginBps));
  const floorBps = VAULT_LP_MIN_JUNIOR_FLOOR_BPS;
  const caps = projectCreatorCaps(j, k, floorBps);
  const fmt = (a: bigint) => `${formatTokenAmount(a, decimals)} ${collateralSymbol}`;
  return (
    <div data-testid="limits-wizard-tranche" className="mt-4 border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-0.5">
      <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">Your junior tranche</p>
      <LimitsRow label="Junior (first-loss)" value={fmt(j)} />
      <LimitsRow
        label="Max LP exposure"
        tooltip="The protocol caps the LP's open exposure at your junior capital times the market's max leverage."
        value={fmt(caps.maxLpNotionalAtoms)}
      />
      <LimitsRow
        label="Max Earn deposits"
        tooltip={`Earn deposits are capped so your junior stays at least ${floorBps / 100}% of them.`}
        value={fmt(caps.maxSeniorAtoms)}
      />
      <p className="pt-1 text-[9px] leading-relaxed text-[var(--text-secondary)]">{COPY.wizardRequirement(`${floorBps / 100}%`)}</p>
      <p className="text-[9px] text-[var(--text-dim)]">{COPY.wizardAfterLaunch}</p>
    </div>
  );
};

/** Mounts the data hooks only when a limits flag is on (flag-off = zero extra RPC). */
export const CreatorTranchePanel: FC<{ slab: string; decimals: number; collateralSymbol: string }> = (p) => {
  const f = limitsFlags();
  if (!f.p1 && !f.p3) return null;
  return <CreatorTranchePanelLive {...p} />;
};

const CreatorTranchePanelLive: FC<{ slab: string; decimals: number; collateralSymbol: string }> = ({ slab, decimals, collateralSymbol }) => {
  const limits = useMarketLimits(slab);
  const { state: lpState } = useInsuranceLP();
  const { assetProfile } = useSlabState();
  return (
    <CreatorTranchePanelView
      limits={limits}
      slab={slab}
      backingNavAtoms={lpState.vaultTotalAtoms}
      totalShares={lpState.lpSupply}
      creatorFeesAtoms={assetProfile?.creatorFeeClaimableAtoms ?? null}
      decimals={decimals}
      collateralSymbol={collateralSymbol}
    />
  );
};

export const CreatorTranchePanelView: FC<{
  limits: MarketLimits;
  slab: string;
  backingNavAtoms: bigint;
  totalShares: bigint;
  creatorFeesAtoms: bigint | null;
  decimals: number;
  collateralSymbol: string;
}> = ({ limits, slab, backingNavAtoms, totalShares, creatorFeesAtoms, decimals, collateralSymbol }) => {
  if (limits.state === "off" || (!limits.flags.p3 && !limits.flags.p1)) return null;
  const fmt = (a: bigint) => `${formatTokenAmount(a, decimals)} ${collateralSymbol}`;
  const e = limits.engine;
  const lp = limits.lp;
  const vs = limits.flags.p3 ? limits.vaultState : null;
  const view = earnViewFromLimits(limits, backingNavAtoms, totalShares, 0n);
  const lpFlat = lp ? lp.posQ === 0n : false;
  const withdrawable =
    view && vs && view.vaultValue !== null
      ? lpFlat
        ? juniorWithdrawableAtoms(view.vaultValue, view.seniorClaimEff, view.backingCover, vs.juniorFloorBps)
        : 0n
      : null;
  const sides =
    limits.flags.p1 && e && limits.riskLimits
      ? maxTradeSizePerSide({
          priceE6: e.effectivePriceE6,
          initialMarginBps: e.initialMarginBps,
          oiEffLongQ: e.oiEffLongQ,
          oiEffShortQ: e.oiEffShortQ,
          limits: limits.riskLimits,
          lp,
          takerPosQ: 0n,
          matcher: limits.matcher ? { maxFillAbs: limits.matcher.maxFillAbs, maxInventoryAbs: limits.matcher.maxInventoryAbs, inventoryBase: limits.matcher.inventoryBase } : null,
        })
      : null;
  const capQ =
    limits.flags.p1 && e && lp && limits.riskLimits
      ? lpExposureCapQ(nonnegEquity(lpEquityInitRaw(lp.capital, lp.pnl, lp.feeCredits)), effectiveLpExposureKBps(limits.riskLimits.lpExposureKBps, e.initialMarginBps), e.effectivePriceE6)
      : null;

  return (
    <div data-testid="limits-creator-tranche" data-market={slab} data-state={limits.state} className="mb-4 space-y-0.5">
      <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">Risk &amp; caps</p>
      {view && (
        <>
          <LimitsRow
            label="Junior at risk"
            value={view.junior === null ? "Needs refresh" : fmt(view.junior)}
            valueClass={view.junior === 0n ? "text-[var(--short)]" : undefined}
          />
          <LimitsRow label="Cushion vs Earn" value={view.cushionBps === null ? "—" : `${(view.cushionBps / 100).toFixed(1)}%`} />
          <LimitsRow
            label="Withdrawable now"
            tooltip="Junior above the floor, only while the LP is flat and the vault's backing covers Earn deposits."
            value={withdrawable === null ? "—" : withdrawable === 0n ? (lpFlat ? "0" : "0 · LP has open positions") : fmt(withdrawable)}
          />
        </>
      )}
      {creatorFeesAtoms !== null && <LimitsRow label="Creator fees (claimable)" value={fmt(creatorFeesAtoms)} />}
      {capQ !== null && <LimitsRow label="LP exposure cap" value={`${fmtQ(capQ)} units`} />}
      {sides && (
        <LimitsRow
          label="Max trade long / short"
          value={`${sides.long.halted ? "Paused" : fmtQ(sides.long.maxQ)} / ${sides.short.halted ? "Paused" : fmtQ(sides.short.maxQ)}`}
        />
      )}
      {view?.impaired === true && (
        <LimitsNotice tone="error" title="Senior impaired" testId="limits-creator-impaired">
          Your junior tranche is exhausted: further trader profits are paid by Earn depositors, and new Earn deposits are paused.
        </LimitsNotice>
      )}
    </div>
  );
};
