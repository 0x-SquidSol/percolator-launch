"use client";

import { FC, useState } from "react";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useLivePrice } from "@/hooks/useLivePrice";
import { ClosePositionModal } from "@/components/trade/ClosePositionModal";
import { computeMarkPnl, computeMarkPnlCollateral } from "@/lib/trading";
import { formatTokenAmount, formatUsdPriceE6 } from "@/lib/format";

export interface OrderTicketClosePanelProps {
  slabAddress: string;
  /** Signed position size (base units); 0n = nothing to close. */
  positionSize: bigint;
  /** Resolved entry price (E6) — same resolution the ticket uses elsewhere. */
  entryPriceE6: bigint;
  capital: bigint;
  symbol: string;
  collateralSymbol: string;
  decimals: number;
  tradingFeeBps?: bigint;
  /** Per-fill cap (matcherCaps.maxFillAbs), surfaced by the modal when a close batches. */
  maxFillAbs: bigint | null;
  /** The market's LP has no capital: a close cannot fill (mirrors PositionsDock). */
  lpUnderfunded: boolean;
  /** Engine accrue-staleness: every close reverts until a re-seed (mirrors PositionsDock). */
  engineStale: boolean;
  /** Oracle unavailable/stale (already mock-mode aware) — blocks Confirm in the modal. */
  oracleBlocked: boolean;
  /** Called after a SUCCESSFUL close with the percent that was closed. */
  onClosed: (percent: number) => void;
}

/**
 * Close mode of the order ticket (GH#2651).
 *
 * A separate component, mounted ONLY in Close mode, for two reasons:
 *  - `OrderTicket` deliberately does not subscribe to the live price (see its
 *    file header); this panel needs a REACTIVE mark for PnL and for the modal's
 *    Est. receive, and must not drag that subscription into the open form.
 *  - `useClosePosition` (useTrade + slab + user-account subscriptions) is not
 *    free, so it is only mounted while the trader is actually closing.
 *
 * All close logic stays in `useClosePosition` (fresh on-chain size read, so a
 * stale UI size cannot over-close into an opposite position) and the shared
 * `ClosePositionModal`; this component only decides WHEN closing is allowed,
 * with the same gates PositionsDock / PositionPanel apply.
 */
export const OrderTicketClosePanel: FC<OrderTicketClosePanelProps> = ({
  slabAddress,
  positionSize,
  entryPriceE6,
  capital,
  symbol,
  collateralSymbol,
  decimals,
  tradingFeeBps,
  maxFillAbs,
  lpUnderfunded,
  engineStale,
  oracleBlocked,
  onClosed,
}) => {
  const { closePosition, loading, error, prewarmClose } = useClosePosition(slabAddress);
  const { priceE6, priceUsd } = useLivePrice();
  const [showModal, setShowModal] = useState(false);

  const currentPriceE6 = priceE6 ?? 0n;
  const hasValidMark = currentPriceE6 > 0n;
  const hasPosition = positionSize !== 0n;
  const isLong = positionSize > 0n;
  const absSize = positionSize < 0n ? -positionSize : positionSize;

  // Mark-to-market PnL in COLLATERAL units, via the same two helpers the dock
  // uses. The on-chain `account.pnl` is in the native coin-margined scale, so
  // showing it raw next to a collateral symbol would be off by ~the price.
  const pnlTokens =
    hasPosition && hasValidMark && entryPriceE6 > 0n
      ? computeMarkPnlCollateral(computeMarkPnl(positionSize, entryPriceE6, currentPriceE6), currentPriceE6)
      : null;
  const pnlAbs = pnlTokens !== null && pnlTokens < 0n ? -pnlTokens : (pnlTokens ?? 0n);
  const pnlColor =
    pnlTokens === null || pnlTokens === 0n
      ? "text-[var(--text-secondary)]"
      : pnlTokens > 0n
        ? "text-[var(--long)]"
        : "text-[var(--short)]";
  const pnlSign = pnlTokens === null || pnlTokens === 0n ? "" : pnlTokens > 0n ? "+" : "-";

  const buttonDisabled = loading || lpUnderfunded || !hasValidMark || engineStale;
  const buttonLabel = loading
    ? "Closing…"
    : !hasValidMark
      ? "Awaiting Price…"
      : engineStale
        ? "Crank Behind"
        : "Close Position";
  const buttonTitle = !hasValidMark
    ? "Waiting for price data…"
    : engineStale
      ? "Market crank behind — trading paused. This market needs a re-seed before closing works."
      : lpUnderfunded
        ? "The LP has no capital, so a close cannot fill."
        : undefined;

  const handleConfirm = async (percent: number) => {
    try {
      await closePosition(percent);
      setShowModal(false);
      onClosed(percent);
    } catch {
      // Surfaced through `error`, which the modal renders inline.
    }
  };

  if (!hasPosition) {
    return (
      <div className="rounded-none border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-8 text-center">
        <p className="text-[12px] font-medium text-[var(--text)]">No open position</p>
        <p className="mx-auto mt-1.5 max-w-[240px] text-[11px] leading-relaxed text-[var(--text-secondary)]">
          You have no open position in this market to close. Switch to Open to place a trade.
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <div
        className={`mb-3 rounded-none border px-3 py-2.5 ${
          isLong ? "border-[var(--long)]/25 bg-[var(--long)]/[0.04]" : "border-[var(--short)]/25 bg-[var(--short)]/[0.04]"
        }`}
      >
        <div className="flex items-center justify-between">
          <span className={`text-[11px] font-bold uppercase tracking-[0.1em] ${isLong ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
            {isLong ? "Long" : "Short"} Position
          </span>
          <span className="text-[10px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
            Entry {entryPriceE6 > 0n ? formatUsdPriceE6(entryPriceE6) : "--"}
          </span>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-semibold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            {formatTokenAmount(absSize, decimals)} {symbol}
          </span>
          <span className={`shrink-0 text-[12px] font-semibold ${pnlColor}`} style={{ fontFamily: "var(--font-mono)" }}>
            {pnlTokens === null ? "--" : `${pnlSign}${formatTokenAmount(pnlAbs, decimals)} ${collateralSymbol}`}
          </span>
        </div>
      </div>

      {error && (
        <div className="mb-2 rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
          <p className="text-[10px] text-[var(--short)]">{error}</p>
        </div>
      )}

      <button
        onClick={() => {
          prewarmClose();
          setShowModal(true);
        }}
        disabled={buttonDisabled}
        title={buttonTitle}
        className="w-full rounded-none border border-[var(--short)] bg-[var(--short)] py-3 text-[12px] font-bold uppercase tracking-[0.1em] text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {buttonLabel}
      </button>
      <p className="mt-2 text-center text-[10px] text-[var(--text-secondary)]">
        Pick an amount and confirm the fee &amp; est. receive in the next step.
      </p>

      {showModal && (
        <ClosePositionModal
          positionSize={positionSize}
          entryPrice={entryPriceE6}
          currentPrice={currentPriceE6}
          capital={capital}
          symbol={symbol}
          collateralSymbol={collateralSymbol}
          decimals={decimals}
          priceUsd={priceUsd}
          isLong={isLong}
          loading={loading}
          tradingFeeBps={tradingFeeBps}
          // Defense in depth: the button above is already disabled on
          // engineStale, but keep Confirm blocked if it flips with the modal open.
          oracleStale={oracleBlocked || engineStale}
          error={error}
          maxFillAbs={maxFillAbs}
          onConfirm={handleConfirm}
          onCancel={() => setShowModal(false)}
        />
      )}
    </div>
  );
};
