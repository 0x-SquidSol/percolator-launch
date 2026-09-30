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
import { type FC, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useJuniorTranche } from "@/hooks/useJuniorTranche";
import { parseHumanAmount } from "@/lib/parseAmount";
import { useMarketLimits, type MarketLimits } from "@/hooks/useMarketLimits";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useInsuranceLP } from "@/hooks/useInsuranceLP";
import { limitsFlags, p3WizardEnabled } from "@/lib/limits/flags";
import { DEFAULT_JUNIOR_FLOOR_BPS, juniorFloorAtoms, maxWizardFloorBps, validateP3Wizard, vaultLpAwaitingProtocol } from "@/lib/limits/p3-wizard";
import { backingSeedPerDomain } from "@/lib/market-params";
import { COPY } from "@/lib/limits/copy";
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
  /** P3 wizard: junior floor (bps of the senior claim) and its setter. */
  floorBps?: number;
  onFloorChange?: (bps: number) => void;
}> = ({ juniorUnits, initialMarginBps, decimals, collateralSymbol, floorBps, onFloorChange }) => {
  if (!p3WizardEnabled()) return null;
  const j = BigInt(Math.max(0, Math.floor(juniorUnits * 10 ** decimals)));
  const k = defaultLpExposureKBps(BigInt(initialMarginBps));
  const floor = floorBps ?? DEFAULT_JUNIOR_FLOOR_BPS;
  // The vault LP is bound right after the Earn seed (both domains = 2 x backingSeedPerDomain),
  // so the senior claim at InitVaultLp is that seed's NAV.
  const seedNav = 2n * backingSeedPerDomain(j);
  const maxFloor = maxWizardFloorBps(j, seedNav);
  const issue = validateP3Wizard({ juniorFloorBps: floor, juniorAtoms: j, seedNavAtoms: seedNav });
  const caps = projectCreatorCaps(j, k, floor);
  const fmt = (a: bigint) => `${formatTokenAmount(a, decimals)} ${collateralSymbol}`;
  return (
    <div data-testid="limits-wizard-tranche" data-floor-bps={String(floor)} className="mt-4 border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-0.5">
      <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">{COPY.p3Wizard.title}</p>
      <p className="pb-1 text-[9px] leading-relaxed text-[var(--text-secondary)]">{COPY.p3Wizard.explain}</p>
      <LimitsRow label={COPY.p3Wizard.amountLabel} value={fmt(j)} testId="limits-wizard-junior-amount" />
      <div className="flex items-center justify-between py-0.5 text-[10px]">
        <span className="text-[var(--text-secondary)] uppercase tracking-[0.08em]">{COPY.p3Wizard.floorLabel}</span>
        <span className="flex gap-1" role="radiogroup" aria-label={COPY.p3Wizard.floorLabel}>
          {WIZARD_FLOOR_CHOICES_BPS.map((b) => (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={b === floor}
              data-testid="limits-wizard-junior-floor"
              data-value={String(b)}
              disabled={!onFloorChange || b > maxFloor}
              onClick={() => onFloorChange?.(b)}
              className={`border px-1.5 py-0.5 font-mono text-[9px] tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                b === floor ? "border-[var(--accent)]/60 text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text)]"
              }`}
            >
              {b / 100}%
            </button>
          ))}
        </span>
      </div>
      <LimitsRow
        label="Max LP exposure"
        tooltip="The protocol caps the LP's open exposure at your junior capital times the market's max leverage."
        value={fmt(caps.maxLpNotionalAtoms)}
      />
      <LimitsRow
        label="Max Earn deposits"
        tooltip={`Earn deposits are capped so your junior stays at least ${floor / 100}% of them.`}
        value={fmt(caps.maxSeniorAtoms)}
      />
      <p className="pt-1 text-[9px] text-[var(--text-dim)]">{COPY.p3Wizard.minHint(fmt(juniorFloorAtoms(seedNav, floor)).replace(` ${collateralSymbol}`, ""), collateralSymbol)}</p>
      {issue && (
        <p data-testid="limits-wizard-junior-issue" data-issue={issue} className="text-[9px] text-[var(--short)]">
          {COPY.p3Wizard.issue[issue]}
        </p>
      )}
      <p data-testid="limits-wizard-awaiting-protocol" className="text-[9px] leading-relaxed text-[var(--warning)]">
        {COPY.p3Wizard.awaitingProtocol}
      </p>
    </div>
  );
};

/**
 * Junior tranche top-up (96) / withdraw (97) for the junior owner. Withdraw is capped at the
 * program's "withdrawable now" (LP flat, above the floor, backing covers the seniors).
 */
export const JuniorTrancheActionsView: FC<{
  withdrawableAtoms: bigint | null;
  decimals: number;
  collateralSymbol: string;
  busy: boolean;
  error: string | null;
  onDeposit: (atoms: bigint) => void;
  onWithdraw: (atoms: bigint) => void;
}> = ({ withdrawableAtoms, decimals, collateralSymbol, busy, error, onDeposit, onWithdraw }) => {
  const [raw, setRaw] = useState("");
  let atoms = 0n;
  try {
    atoms = raw.trim() ? parseHumanAmount(raw, decimals) : 0n;
  } catch {
    atoms = 0n;
  }
  const canWithdraw = atoms > 0n && withdrawableAtoms !== null && atoms <= withdrawableAtoms;
  return (
    <div data-testid="limits-junior-actions" className="mb-3 border border-[var(--border)] bg-[var(--panel-bg)] p-3">
      <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">Junior tranche</p>
      <input
        data-testid="limits-junior-amount-input"
        inputMode="decimal"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder={`Amount (${collateralSymbol})`}
        className="w-full border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-[11px] text-[var(--text)]"
      />
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          data-testid="limits-junior-deposit"
          disabled={busy || atoms <= 0n}
          onClick={() => onDeposit(atoms)}
          className="border border-[var(--accent)]/50 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Top up
        </button>
        <button
          type="button"
          data-testid="limits-junior-withdraw"
          disabled={busy || !canWithdraw}
          onClick={() => onWithdraw(atoms)}
          className="border border-[var(--border)] py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Withdraw
        </button>
      </div>
      {error && (
        <p data-testid="limits-junior-error" className="mt-2 text-[9px] text-[var(--short)]">
          {error}
        </p>
      )}
    </div>
  );
};

/** Floors the wizard offers (the program accepts 1000..=10000). */
export const WIZARD_FLOOR_CHOICES_BPS = [1_000, 2_000, 3_000, 5_000] as const;

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
  const wallet = useWalletCompat();
  const junior = useJuniorTranche(slab);
  const vs = limits.flags.p3 ? limits.vaultState : null;
  const isJuniorOwner = !!vs && !!wallet.publicKey && new PublicKey(vs.juniorOwner).equals(wallet.publicKey);
  const view = earnViewFromLimits(limits, lpState.vaultTotalAtoms, 0n);
  const withdrawable =
    view && vs && view.vaultValue !== null && limits.lp?.posQ === 0n
      ? juniorWithdrawableAtoms(view.vaultValue, view.seniorClaimEff, view.backingCover, vs.juniorFloorBps)
      : vs
        ? 0n
        : null;
  return (
    <>
      {vaultLpAwaitingProtocol(limits.vaultLp) && (
        <LimitsNotice tone="warning" title="Awaiting protocol approval" testId="limits-creator-awaiting-protocol">
          {COPY.p3Wizard.awaitingProtocol}
        </LimitsNotice>
      )}
      {isJuniorOwner && (
        <JuniorTrancheActionsView
          withdrawableAtoms={withdrawable}
          decimals={decimals}
          collateralSymbol={collateralSymbol}
          busy={junior.busy}
          error={junior.error}
          onDeposit={(a) => void junior.deposit(a).catch(() => undefined)}
          onWithdraw={(a) => void junior.withdraw(a).catch(() => undefined)}
        />
      )}
      <CreatorTranchePanelView
      limits={limits}
      slab={slab}
      backingNavAtoms={lpState.vaultTotalAtoms}
      creatorFeesAtoms={assetProfile?.creatorFeeClaimableAtoms ?? null}
      decimals={decimals}
      collateralSymbol={collateralSymbol}
      />
    </>
  );
};

export const CreatorTranchePanelView: FC<{
  limits: MarketLimits;
  slab: string;
  backingNavAtoms: bigint;
  creatorFeesAtoms: bigint | null;
  decimals: number;
  collateralSymbol: string;
}> = ({ limits, slab, backingNavAtoms, creatorFeesAtoms, decimals, collateralSymbol }) => {
  if (limits.state === "off" || (!limits.flags.p3 && !limits.flags.p1)) return null;
  const fmt = (a: bigint) => `${formatTokenAmount(a, decimals)} ${collateralSymbol}`;
  const e = limits.engine;
  const lp = limits.lp;
  const vs = limits.flags.p3 ? limits.vaultState : null;
  const view = earnViewFromLimits(limits, backingNavAtoms, 0n);
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
