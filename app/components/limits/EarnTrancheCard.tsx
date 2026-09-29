"use client";

/**
 * P3 Earn tranche card (plan §2 P3-a/b/c): NAV share price, senior vs junior
 * tranche sizes, first-loss cushion, withdrawal effect, APY from REAL fee
 * credits, and the risk disclosure. Flag NEXT_PUBLIC_LIMITS_P3; renders
 * nothing when off, or when the market's vault does not own its LP.
 */
import { useEffect, useMemo, useState, type FC } from "react";
import { useMarketLimits, type MarketLimits } from "@/hooks/useMarketLimits";
import { COPY } from "@/lib/limits/copy";
import { earnTrancheView, rollFeeSnapshots, type FeeSnapshot } from "@/lib/limits/vault-tranche";
import { formatTokenAmount } from "@/lib/format";
import { LimitsNotice, LimitsRow } from "./LimitsRow";

export interface EarnTrancheCardProps {
  slab: string;
  /** Existing Earn vault NAV (useInsuranceLP.vaultTotalAtoms). */
  backingNavAtoms: bigint;
  totalShares: bigint;
  /** Shares typed into the withdraw box (0 = none). */
  withdrawShares: bigint;
  decimals: number;
  collateralSymbol: string;
}

export const EarnTrancheCard: FC<EarnTrancheCardProps> = (p) => {
  const limits = useMarketLimits(p.slab);
  return <EarnTrancheCardView limits={limits} {...p} />;
};

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

export const EarnTrancheCardView: FC<EarnTrancheCardProps & { limits: MarketLimits; nowSecs?: number }> = ({
  limits,
  slab,
  backingNavAtoms,
  totalShares,
  withdrawShares,
  decimals,
  collateralSymbol,
  nowSecs,
}) => {
  const vs = limits.vaultState;
  const lp = limits.lp;
  const view = useMemo(() => {
    if (!vs) return null;
    const lpValue = lp ? lpEquityInitRawPositive(lp.capital, lp.pnl, lp.feeCredits) : 0n;
    return earnTrancheView({
      seniorClaimAtoms: vs.seniorClaimAtoms,
      juniorFloorBps: vs.juniorFloorBps,
      seniorFeeShareBps: vs.seniorFeeShareBps,
      backingNavAtoms,
      harvestableAtoms: 0n,
      lpValueAtoms: lpValue,
      totalShares,
      withdrawShares,
    });
  }, [vs, lp, backingNavAtoms, totalShares, withdrawShares]);

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
  const fmt = (a: bigint) => `${formatTokenAmount(a, decimals)} ${collateralSymbol}`;
  const resolved = limits.engine?.mode === 1;

  return (
    <div
      data-testid="limits-tranche-card"
      data-status={view.impaired ? "impaired" : "covered"}
      data-state={limits.state}
      className="mb-3 border border-[var(--border)] bg-[var(--panel-bg)] p-3 space-y-0.5"
    >
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">Vault tranches</p>
        <span
          className={`border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${
            view.impaired ? "border-[var(--short)]/40 text-[var(--short)]" : "border-[var(--long)]/40 text-[var(--long)]"
          }`}
        >
          {view.impaired ? "Impaired" : "Covered"}
        </span>
      </div>
      <LimitsRow
        testId="limits-share-price"
        data={{ "price-e6": view.sharePriceE6?.toString() ?? "" }}
        label="Share price"
        tooltip="Senior tranche value per Earn share. It holds at its principal while the creator's junior tranche absorbs losses."
        value={view.sharePriceE6 === null ? "—" : (Number(view.sharePriceE6) / 1e6).toFixed(6)}
      />
      <LimitsRow label="Senior (Earn)" value={fmt(view.senior)} />
      <LimitsRow label="Junior (creator)" value={fmt(view.junior)} />
      <LimitsRow
        label="First-loss cushion"
        tooltip="Junior tranche as a share of Earn deposits: how much trader profit the creator's capital covers before Earn depositors lose anything."
        value={view.cushionBps === null ? "—" : `${(view.cushionBps / 100).toFixed(1)}%`}
        valueClass={view.cushionBps !== null && view.cushionBps < 1_000 ? "text-[var(--warning)]" : undefined}
      />
      <LimitsRow
        testId="limits-apy"
        data={{ state: apyBps === null ? "insufficient-history" : "ready" }}
        label="APY (fees, trailing)"
        tooltip="Annualised from LP fees actually credited to the senior tranche on-chain. Never a projection."
        value={apyBps === null ? <span className="text-[var(--text-dim)]">{COPY.apyInsufficient}</span> : `${(apyBps / 100).toFixed(2)}%`}
      />
      {withdrawShares > 0n && (
        <p
          className={`pt-1 text-[9px] leading-relaxed ${view.withdrawKind === "normal" ? "text-[var(--text-secondary)]" : "text-[var(--warning)]"}`}
          data-testid="limits-withdraw-effect"
          data-kind={view.withdrawKind}
        >
          {view.withdrawAtoms !== null && COPY.withdrawReceive(fmt(view.withdrawAtoms))}{" "}
          {view.withdrawKind === "impaired" && COPY.withdrawImpaired(fmt(view.senior))}
          {view.withdrawKind === "illiquid" && COPY.withdrawIlliquid}
        </p>
      )}
      {view.impaired && <p className="text-[9px] text-[var(--short)]">{COPY.depositsPausedImpaired}</p>}
      {resolved && <p className="text-[9px] text-[var(--warning)]">{COPY.resolvedVault}</p>}
      <div className="pt-2">
        <LimitsNotice tone="info" testId="limits-risk-disclosure">
          {COPY.riskDisclosure}
        </LimitsNotice>
      </div>
    </div>
  );
};

function lpEquityInitRawPositive(capital: bigint, pnl: bigint, feeCredits: bigint): bigint {
  // LP value for V: capital + pnl − fee debt (positive pnl counted, as the certified equity does), floored at 0.
  const debt = feeCredits < 0n ? -feeCredits : feeCredits;
  const v = capital + pnl - debt;
  return v < 0n ? 0n : v;
}
