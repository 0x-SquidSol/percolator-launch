"use client";

/**
 * P3 Earn tranche card (plan §2 P3-a/b/c): NAV share price, senior vs junior
 * tranche sizes, first-loss cushion, withdrawal effect, APY from REAL fee
 * credits, and the risk disclosure. Values follow the program's own NAV path:
 * the vault LP is valued from its CERTIFIED equity (or conservative equity when
 * flat), pending LP fees are the on-chain harvestable leg. When the LP's
 * certificate is stale the card says so instead of guessing. Pure renderer:
 * the rail passes the one `useMarketLimits` instance it also gates deposits with.
 */
import { useEffect, useState, type FC } from "react";
import type { MarketLimits } from "@/hooks/useMarketLimits";
import { COPY } from "@/lib/limits/copy";
import { earnAbsorbed, rollFeeSnapshots, type EarnTrancheView, type FeeSnapshot } from "@/lib/limits/vault-tranche";
import { formatTokenAmount } from "@/lib/format";
import { LimitsNotice, LimitsRow } from "./LimitsRow";

export interface EarnTrancheCardViewProps {
  limits: MarketLimits;
  view: EarnTrancheView | null;
  slab: string;
  withdrawShares: bigint;
  decimals: number;
  collateralSymbol: string;
  nowSecs?: number;
}

const SNAP_KEY = (slab: string) => `perc.limits.feeSnapshots.${slab}`;

function loadSnaps(slab: string): FeeSnapshot[] {
  try {
    const raw = window.localStorage.getItem(SNAP_KEY(slab));
    if (!raw) return [];
    const arr = JSON.parse(raw) as { t: number; f: string; c: string }[];
    return arr.map((x) => ({ t: x.t, seniorFeeCreditedAtoms: BigInt(x.f), seniorClaimAtoms: BigInt(x.c) }));
  } catch {
    return [];
  }
}
function saveSnaps(slab: string, list: FeeSnapshot[]): void {
  try {
    window.localStorage.setItem(
      SNAP_KEY(slab),
      JSON.stringify(list.map((s) => ({ t: s.t, f: s.seniorFeeCreditedAtoms.toString(), c: s.seniorClaimAtoms.toString() }))),
    );
  } catch {
    /* private window / blocked storage: APY simply stays "needs history" */
  }
}

export const EarnTrancheCardView: FC<EarnTrancheCardViewProps> = ({ limits, view, slab, withdrawShares, decimals, collateralSymbol, nowSecs }) => {
  const vs = limits.vaultState;
  const [apyBps, setApyBps] = useState<number | null>(null);
  useEffect(() => {
    if (!vs) return;
    const now: FeeSnapshot = {
      t: nowSecs ?? Math.floor(Date.now() / 1000),
      seniorFeeCreditedAtoms: vs.seniorFeeCreditedAtoms,
      seniorClaimAtoms: vs.seniorClaimAtoms,
    };
    const r = rollFeeSnapshots(loadSnaps(slab), now);
    saveSnaps(slab, r.list);
    setApyBps(r.apyBps);
  }, [vs, slab, nowSecs]);

  if (!limits.flags.p3 || limits.state === "off") return null;
  if (limits.state === "loading") {
    return <div data-testid="limits-tranche-card" data-state="loading" className="mb-3 h-24 animate-pulse border border-[var(--border)] bg-[var(--bg-elevated)]" />;
  }
  if (!vs || !view) return null; // vault does not own an LP on this market
  const fmt = (a: bigint | null) => (a === null ? "—" : `${formatTokenAmount(a, decimals)} ${collateralSymbol}`);
  const resolved = limits.engine?.mode === 1;
  const status = view.impaired === null ? "stale" : view.impaired ? "impaired" : "covered";
  const absorbed = earnAbsorbed(vs);

  return (
    <div
      data-testid="limits-tranche-card"
      data-status={status}
      data-valuation={view.valuation}
      data-state={limits.state}
      className="mb-3 border border-[var(--border)] bg-[var(--panel-bg)] p-3 space-y-0.5"
    >
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">Vault tranches</p>
        <span
          className={`border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${
            status === "impaired"
              ? "border-[var(--short)]/40 text-[var(--short)]"
              : status === "stale"
                ? "border-[var(--warning)]/40 text-[var(--warning)]"
                : "border-[var(--long)]/40 text-[var(--long)]"
          }`}
        >
          {status === "impaired" ? "Impaired" : status === "stale" ? "Needs refresh" : "Covered"}
        </span>
      </div>
      <LimitsRow
        testId="limits-share-price"
        data={{ "price-e6": view.sharePriceE6?.toString() ?? "" }}
        label="Share price"
        tooltip="Senior tranche value per Earn share. The creator's junior tranche takes losses first; only a loss bigger than the junior reaches Earn, and then every Earn depositor loses the same percentage, so it can fall below principal."
        value={view.sharePriceE6 === null ? "—" : (Number(view.sharePriceE6) / 1e6).toFixed(6)}
      />
      <LimitsRow label="Senior (Earn)" value={fmt(view.senior)} />
      <LimitsRow
        testId="limits-junior-value"
        data={{ valuation: view.valuation }}
        label="Junior (creator)"
        tooltip={
          view.valuation === "certified"
            ? "Includes the vault LP at its certified equity (the program's own valuation)."
            : view.valuation === "flat"
              ? "The vault LP is flat; valued at its capital net of losses and fee debt."
              : COPY.valuationStale
        }
        value={fmt(view.junior)}
      />
      <LimitsRow
        label="First-loss cushion"
        tooltip="Junior tranche as a share of Earn deposits: how big a loss the creator's capital takes before any of it reaches Earn. Winning traders are always paid in full unless Earn's backing is used up too."
        value={view.cushionBps === null ? "—" : `${(view.cushionBps / 100).toFixed(1)}%`}
        valueClass={view.cushionBps !== null && view.cushionBps < 1_000 ? "text-[var(--warning)]" : undefined}
      />
      {absorbed && (
        <LimitsRow
          testId="limits-earn-absorbed"
          data={{ outstanding: absorbed.outstanding.toString(), drawn: absorbed.drawn.toString() }}
          label={COPY.earnAbsorbedLabel}
          tooltip={COPY.earnAbsorbedTooltip(fmt(absorbed.drawn), fmt(absorbed.restored))}
          value={fmt(absorbed.outstanding)}
          valueClass={absorbed.outstanding > 0n ? "text-[var(--short)]" : undefined}
        />
      )}
      <LimitsRow
        testId="limits-pending-fees"
        data={{ excludes: view.excludesUncrankedFees ? "true" : "false" }}
        label="Pending LP fees"
        tooltip="LP fees earned but not yet cranked into the vault. They are priced into the share value already."
        value={view.excludesUncrankedFees ? <span className="text-[var(--text-dim)]">{COPY.excludesUncrankedFees}</span> : fmt(view.harvestable)}
      />
      <LimitsRow
        testId="limits-apy"
        data={{ state: apyBps === null ? "insufficient-history" : "ready" }}
        label="APY (fees, trailing)"
        tooltip="Annualised from LP fees actually credited to the senior tranche on-chain. Never a projection."
        value={apyBps === null ? <span className="text-[var(--text-dim)]">{COPY.apyInsufficient}</span> : `${(apyBps / 100).toFixed(2)}%`}
      />
      {view.valuation === "stale" && <p className="text-[9px] text-[var(--warning)]">{COPY.valuationStale}</p>}
      {withdrawShares > 0n && (
        <p
          className={`pt-1 text-[9px] leading-relaxed ${view.withdrawKind === "normal" ? "text-[var(--text-secondary)]" : "text-[var(--warning)]"}`}
          data-testid="limits-withdraw-effect"
          data-kind={view.withdrawKind}
        >
          {view.withdrawAtoms !== null && COPY.withdrawReceive(fmt(view.withdrawAtoms))}{" "}
          {view.withdrawKind === "impaired" && COPY.withdrawImpaired(fmt(view.senior))}
          {view.withdrawKind === "illiquid" && COPY.withdrawIlliquid}
          {view.withdrawKind === "stale" && COPY.valuationStale}
        </p>
      )}
      {view.impaired === true && <p className="text-[9px] text-[var(--short)]">{COPY.depositsPausedImpaired}</p>}
      {resolved && <p className="text-[9px] text-[var(--warning)]">{COPY.resolvedVault}</p>}
      <div className="pt-2">
        <LimitsNotice tone="info" testId="limits-risk-disclosure">
          {COPY.riskDisclosure}
        </LimitsNotice>
      </div>
    </div>
  );
};
