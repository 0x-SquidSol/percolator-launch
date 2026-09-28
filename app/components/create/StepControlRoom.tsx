"use client";

import { FC, useMemo } from "react";
import { RotaryDial } from "./RotaryDial";
import { HoldToLaunch } from "./HoldToLaunch";
import { MAX_LEVERAGE_X, MIN_LEVERAGE_X } from "@/lib/market-params";
import { FeeBreakdown } from "@/components/FeeBreakdown";

/**
 * GH#2621. The dial used to stop at 6.5x, deriving its ceiling from
 * MIN_SAFE_INITIAL_MARGIN_BPS (1500 bps = 15%) and telling the creator the
 * protocol enforced a 15% margin floor.
 *
 * It does not. That floor was removed after the July bisection behind it was
 * re-tested and recorded as a misdiagnosis: "10x fails only when paired with the
 * old 1x500 budget ... With a compatible budget (4 x 100 = 400) 10x is accepted.
 * Leverage was never the problem" (market-params.ts). `create()` applies no such
 * clamp, `flooredInitialMarginBps(1000)` returns 1000, form validation accepts
 * down to 1000 bps, and InitMarket does not bound initial_margin_bps at all.
 * This dial was the last thing still enforcing it.
 *
 * The bounds now come from the same constants everything else uses, so there is
 * one authority on the range rather than two that can drift apart. The real
 * constraint — the price-move budget a given maintenance margin allows — stays
 * where it belongs, in deriveMarketParams' on-chain-bisected table.
 */
export const MAX_LEVERAGE = MAX_LEVERAGE_X;
export const MIN_LEVERAGE = MIN_LEVERAGE_X;

export const leverageToMarginBps = (lev: number): number => Math.round(10_000 / lev);

/**
 * Clamped to the dial's own range on purpose. The old 1500-bps floor happened to
 * guarantee this — it could never return more than 6.67, which was inside the
 * range — and removing it took the guarantee with it. RotaryDial does NOT clamp
 * its incoming `value` prop (only `commit` clamps), so an out-of-range value
 * paints the needle past the end of the arc and renders a nonsense readout: a
 * stored 0 bps would have read "10000x". Nothing produces one today, but
 * CreateMarketWizard restores wizard state from localStorage with a bare spread
 * and does not sanitise initialMarginBps, so the guarantee is worth keeping
 * explicitly rather than by accident.
 */
export const marginBpsToLeverage = (bps: number): number => {
  // Non-finite first: Math.max(MIN, NaN) is NaN, so a clamp alone does not close
  // this. Fall back to the conservative end rather than the aggressive one.
  if (!Number.isFinite(bps) || bps <= 0) return MIN_LEVERAGE;
  return Math.min(MAX_LEVERAGE, Math.max(MIN_LEVERAGE, Math.round((10_000 / bps) * 2) / 2));
};

/**
 * Insurance seed floor. Insurance is written ONCE at market creation and is
 * the layer that absorbs losses before the LP — a market seeded at 0 can never
 * be repaired (see the permanently blocklisted H9ey1RBn… / 4hJ9hUot…, retired
 * for exactly this). The dial therefore cannot be turned below this.
 */
const MIN_INSURANCE = 100;

export interface StepControlRoomProps {
  symbol: string;
  /** Auto-detected, not user-set — shown as a pre-flight readout. */
  oracleLabel: string;
  startPrice: string;
  /** Slab is always max capacity in v17 — there is no tier to pick. */
  slabBytes: number;
  rentSol: number | null;

  initialMarginBps: number;
  /** Displayed as a fixed readout — NOT creator-settable. One rate for every
   *  market, so a creator cannot undercut the fees that keep theirs solvent.
   *  Deliberately has no setter in this contract; see step-control-room-contract.test.tsx. */
  tradingFeeBps: number;
  lpCollateral: string;
  insuranceAmount: string;
  collateralSymbol: string;

  onMarginBpsChange: (bps: number) => void;
  onLpCollateralChange: (v: string) => void;
  onInsuranceChange: (v: string) => void;

  onLaunch: () => void;
  launchDisabled?: boolean;
  launchDisabledReason?: string;
  instantLaunch?: boolean;
  onBack: () => void;
}

const Readout: FC<{ k: string; v: string; tone?: "good" | "plain" }> = ({ k, v, tone = "plain" }) => (
  <div className="flex items-baseline justify-between border-b border-[var(--border-subtle)] py-[7px] last:border-b-0">
    <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">{k}</span>
    <span
      className={`text-[11px] ${tone === "good" ? "text-[var(--long)]" : "text-[var(--text)]"}`}
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {v}
    </span>
  </div>
);

/**
 * Step 2 — the Control Room.
 *
 * Four machined dials for the only four things a creator actually chooses
 * (leverage, liquidity, insurance); everything else — trading fee, price feed, slab
 * size, start price — is auto-resolved and shown as a read-only pre-flight
 * panel, because there is nothing to decide there. Launching is a press-and-hold
 * gesture rather than a click: it is irreversible and costs rent.
 */
export const StepControlRoom: FC<StepControlRoomProps> = ({
  symbol,
  oracleLabel,
  startPrice,
  slabBytes,
  rentSol,
  initialMarginBps,
  tradingFeeBps,
  lpCollateral,
  insuranceAmount,
  collateralSymbol,
  onMarginBpsChange,
  onLpCollateralChange,
  onInsuranceChange,
  onLaunch,
  launchDisabled,
  launchDisabledReason,
  instantLaunch,
  onBack,
}) => {
  const leverage = marginBpsToLeverage(initialMarginBps);
  const lp = Number(lpCollateral) || 0;
  const ins = Number(insuranceAmount) || 0;

  const liqCaption = useMemo(
    () => `liq at ${(100 / leverage).toFixed(1)}% move`,
    [leverage],
  );

  return (
    <div className="space-y-5">
      {/* ── instrument cluster ─────────────────────────────────────────── */}
      <div className="rounded-[4px] border border-[var(--border)] bg-[var(--panel-bg)] p-5">
        <div className="mb-5 flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-secondary)]">
            Market controls
          </div>
          <div className="text-[10px] text-[var(--text-muted)]">drag · scroll · arrow keys</div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
          <RotaryDial
            label="Leverage"
            value={leverage}
            min={MIN_LEVERAGE}
            max={MAX_LEVERAGE}
            step={0.5}
            format={(v) => `${v}×`}
            caption={liqCaption}
            onChange={(v) => onMarginBpsChange(leverageToMarginBps(v))}
          />
          <RotaryDial
            label="Liquidity"
            value={lp}
            min={100}
            max={10_000}
            step={100}
            format={(v) => v.toLocaleString()}
            caption={collateralSymbol}
            onChange={(v) => onLpCollateralChange(String(v))}
          />
          <RotaryDial
            label="Insurance"
            value={ins}
            min={MIN_INSURANCE}
            max={1_000}
            step={25}
            format={(v) => v.toLocaleString()}
            caption={collateralSymbol}
            onChange={(v) => onInsuranceChange(String(v))}
          />
        </div>

        <p className="mt-6 text-[11px] leading-relaxed text-[var(--text-muted)]">
          <span className="text-[var(--text-secondary)]">Leverage</span> sets how far price can move
          before a position liquidates. <span className="text-[var(--text-secondary)]">Liquidity</span> is
          what traders trade against — deeper means less slippage. Leverage runs from{" "}
          {MIN_LEVERAGE}× to {MAX_LEVERAGE}×.
        </p>
      </div>

      {/* ── pre-flight (auto-resolved, nothing to decide) ───────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-[4px] border border-[var(--border)] bg-[var(--panel-bg)] p-4">
          <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-[var(--text-secondary)]">
            Pre-flight
          </div>
          <Readout k="Market" v={`${symbol}-PERP`} />
          <Readout k="Price feed" v={oracleLabel} tone="good" />
          <Readout k="Start price" v={startPrice} />
          <Readout k="Slab" v={`${slabBytes.toLocaleString()} B · max capacity`} />
          <Readout k="Rent" v={rentSol === null ? "—" : `${rentSol.toFixed(3)} SOL`} />
          {/* NOT "same on every market": the fee is derived from the token's
              liquidity tier in useQuickLaunch (20 / 10 / 5 bps) and that value
              is what reaches the chain, so this line used to render e.g.
              "20 bps · same on every market" and contradict itself. The
              creator cannot change it either — FeeSlider is never rendered and
              setTradingFeeBps has no consumers — so "set by liquidity" is the
              honest description of both facts. See #2563. */}
          <Readout k="Trading fee" v={`${tradingFeeBps} bps · set by token liquidity`} />
          {/* A creator is never told they earn a share of this anywhere. #2565. */}
          <div className="col-span-full pt-1">
            <FeeBreakdown highlight="creator" feeBps={tradingFeeBps} />
          </div>
          <Readout k="You seed" v={`${(lp + ins).toLocaleString()} ${collateralSymbol}`} />
          <Readout k="Approvals" v="1" />
        </div>

        <div className="flex flex-col items-center justify-center rounded-[4px] border border-[var(--border)] bg-[var(--panel-bg)] p-4">
          <HoldToLaunch
            onLaunch={onLaunch}
            disabled={launchDisabled}
            disabledReason={launchDisabledReason}
            instant={instantLaunch}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={onBack}
        className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        ← Back to token
      </button>
    </div>
  );
};
