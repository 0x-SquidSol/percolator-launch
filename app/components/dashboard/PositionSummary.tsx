"use client";

import Link from "next/link";
import { computeMarginHealthPct, unliquidatableHealthThresholdPct } from "@/lib/margin-health";
import { usePortfolio, getLiquidationSeverity, isOpenPosition, type PortfolioPosition } from "@/hooks/usePortfolio";
import { formatTokenAmount, formatUsdPriceE6 } from "@/lib/format";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";

import { GlowButton } from "@/components/ui/GlowButton";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";


function formatPnl(pnl: bigint | undefined | null, decimals = 6): string {
  const safePnl = pnl ?? 0n;
  const isNeg = safePnl < 0n;
  const abs = isNeg ? -safePnl : safePnl;
  return `${isNeg ? "-" : "+"}${formatTokenAmount(abs, decimals)}`;
}

function formatPnlPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function PositionCard({ pos, symbol, decimals = 6 }: { pos: PortfolioPosition; symbol: string; decimals?: number }) {
  // Exposure actually carried (ADL-adjusted); equals nominal basis on
  // markets that never deleveraged. See lib/v17-adl.ts.
  const posSize = pos.effectiveSize;
  const side = posSize > 0n ? "Long" : posSize < 0n ? "Short" : "Flat";
  const sizeAbs = posSize < 0n ? -posSize : posSize;
  const severity = getLiquidationSeverity(pos.liquidationDistancePct);
  const hasPosition = posSize !== 0n;
  // GH#2634 (following #2558): cross-margin collateral removes a position's
  // liquidation price, and this card rendered a bare "—" at exactly that
  // point — the symptom #2558 was filed about, on a surface its fix did not
  // reach. Margin health needs no entry or liquidation price, so it is defined
  // precisely when the liquidation price is not. Same helper and the same
  // per-market threshold as the four surfaces #2558 covered.
  const marginHealthPct = computeMarginHealthPct(
    pos.account?.capital ?? 0n,
    pos.account?.positionSize ?? 0n,
    pos.oraclePriceE6,
  );
  const healthThresholdPct = unliquidatableHealthThresholdPct(pos.maintenanceMarginBps);
  // Derived per market, never the literal 105 — that figure is only correct at
  // a 500 bps maintenance margin, and a market with a different one gets a
  // different line.
  // GH#2634: a resolved ENTRY is required, not just a zero liquidation price.
  // computeLiqPrice returns 0n for two unrelated reasons — the long
  // over-collateralisation clamp, and entryPrice === 0n, which means "no data".
  // lib/liquidation-state.ts names this exact distinction and says it "is the
  // same condition the three position components already use". Gating on the
  // bare zero asserted "cannot be liquidated by price" over a gap in the data,
  // which is a false safety claim in the dangerous direction — and for a SHORT
  // it is always that case, since computeLiqPrice never returns 0n for a short
  // with a resolved entry.
  const hasResolvedEntry = (pos.account?.entryPrice ?? 0n) > 0n;
  const showMarginHealth = hasPosition && hasResolvedEntry && pos.liquidationPriceE6 <= 0n && marginHealthPct != null;
  const liqTitle =
    showMarginHealth && marginHealthPct != null
      ? `No liquidation price: collateral is ${marginHealthPct.toFixed(1)}% of this position's notional, past the ${healthThresholdPct}% at which it cannot be liquidated by price. Withdrawing collateral below that brings a liquidation price back.`
      : undefined;
  // PERC-297: Guard PnL display when oracle price is unavailable
  const hasValidOracle = pos.oraclePriceE6 > 0n;

  return (
    <Link
      href={`/trade/${pos.slabAddress}`}
      className={[
        "block border bg-[var(--panel-bg)] transition-all duration-200 hover:bg-[var(--bg-elevated)]",
        severity === "danger" && hasPosition
          ? "border-[var(--short)]/40"
          : severity === "warning" && hasPosition
          ? "border-[var(--warning)]/30"
          : "border-[var(--border)] hover:border-[var(--accent)]/30",
      ].join(" ")}
    >
      {/* Liquidation warning */}
      {severity === "danger" && hasPosition && (
        <div className="flex items-center gap-2 border-b border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-1">
          <span className="text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--short)]">
            ⚠ Liq Risk — {pos.liquidationDistancePct.toFixed(1)}% away
          </span>
        </div>
      )}

      <div className="p-3">
        {/* Row 1: Market, Side, PnL */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span
              className="text-[11px] font-semibold text-[var(--text)]"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              {symbol}
            </span>
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                side === "Long"
                  ? "bg-[var(--long)]/10 text-[var(--long)]"
                  : side === "Short"
                  ? "bg-[var(--short)]/10 text-[var(--short)]"
                  : "bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
              }`}
            >
              {side.toUpperCase()}
            </span>
            {pos.leverage > 0 && (
              <span className="text-[9px] font-bold text-[var(--warning)]">
                {pos.leverage.toFixed(1)}×
              </span>
            )}
          </div>
          <div className="text-right">
            {hasValidOracle ? (
              <>
                <span
                  className={`text-[11px] font-bold ${pos.unrealizedPnl >= 0n ? "text-[var(--long)]" : "text-[var(--short)]"}`}
                  style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                >
                  {formatPnl(pos.unrealizedPnl, decimals)}
                </span>
                <span
                  className={`ml-1 text-[9px] ${pos.pnlPercent >= 0 ? "text-[var(--long)]/70" : "text-[var(--short)]/70"}`}
                >
                  {formatPnlPct(pos.pnlPercent)}
                </span>
              </>
            ) : (
              <span className="text-[11px] font-bold text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                --
              </span>
            )}
          </div>
        </div>

        {/* Row 2: Key metrics */}
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
          <div>
            <span className="text-[var(--text-secondary)]">Size: </span>
            <span className="text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
              {formatTokenAmount(sizeAbs, decimals)}
            </span>
          </div>
          <div>
            <span className="text-[var(--text-secondary)]">Entry: </span>
            <span className="text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
              {pos.account?.entryPrice != null ? formatUsdPriceE6(pos.account.entryPrice) : "—"}
            </span>
          </div>
          <div>
            <span className="text-[var(--text-secondary)]">Mark: </span>
            <span className="text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
              {pos.oraclePriceE6 > 0n ? formatUsdPriceE6(pos.oraclePriceE6) : "—"}
            </span>
          </div>
          <div>
            <span className="text-[var(--text-secondary)]">Liq: </span>
            <span
              title={liqTitle}
              className={`${
                severity === "danger" ? "font-semibold text-[var(--short)]" : severity === "warning" ? "text-[var(--warning)]" : "text-[var(--text-secondary)]"
              }`}
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              {hasPosition && pos.liquidationPriceE6 > 0n
                ? formatUsdPriceE6(pos.liquidationPriceE6)
                : showMarginHealth && marginHealthPct != null
                  ? `${marginHealthPct.toFixed(0)}% mgn`
                  : "—"}
            </span>
          </div>
        </div>

        {/* Margin health bar */}
        {hasPosition && pos.liquidationDistancePct < 100 && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-[8px] text-[var(--text-secondary)]">
              <span>Margin Health</span>
              <span
                className={
                  severity === "danger"
                    ? "font-bold text-[var(--short)]"
                    : severity === "warning"
                    ? "font-bold text-[var(--warning)]"
                    : "text-[var(--text-secondary)]"
                }
              >
                {pos.liquidationDistancePct.toFixed(0)}%
              </span>
            </div>
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[var(--border)]">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(pos.liquidationDistancePct, 100)}%`,
                  backgroundColor:
                    severity === "danger"
                      ? "var(--short)"
                      : severity === "warning"
                      ? "var(--warning)"
                      : "var(--long)",
                }}
              />
            </div>
          </div>
        )}
      </div>
    </Link>
  );
}

export function PositionSummary() {
  const { connected } = useWalletCompat();
  const portfolio = usePortfolio();

  // Only OPEN positions — exclude closed (size-0 "Flat") ones that still have a
  // portfolio account, so a market you've closed doesn't linger in the list/count.
  const positions = ((portfolio.positions ?? []) as PortfolioPosition[]).filter(isOpenPosition);
  const loading = portfolio.loading;

  // v17 markets return an empty `market.config` from the SDK (real value in
  // `market.configV17.collateralMint`) — use the pre-resolved `pos.collateralMint`
  // (set by usePortfolio) instead of `pos.market.config.collateralMint`, which is
  // undefined for v17 markets and crashes `.toBase58()` (this is the crash that
  // took down the whole dashboard shell — no error boundary here).
  const collateralMints = positions.map((pos) => pos.collateralMint);
  const tokenMetaMap = useMultiTokenMeta(collateralMints);

  return (
    <div className="flex h-full flex-col border border-[var(--border)] bg-[var(--panel-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <div className="flex items-center gap-2">
          <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
            Open Positions
          </p>
          <span className="text-[9px] font-bold text-[var(--text-secondary)]">
            ({positions.length})
          </span>
          {positions.length > 0 && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--long)]" />
          )}
        </div>
      </div>

      {/* Position list */}
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <ShimmerSkeleton key={i} className="h-24" />
            ))}
          </div>
        ) : positions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <div className="mb-3 text-2xl opacity-30">📊</div>
            <p className="text-[13px] font-medium text-[var(--text-secondary)]">No open positions</p>
            <p className="mt-1 text-[11px] text-[var(--text-secondary)]">Start trading →</p>
            <Link href="/markets" className="mt-3">
              <GlowButton>Browse Markets</GlowButton>
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {positions.slice(0, 8).map((pos, i) => (
              <PositionCard
                key={`${pos.slabAddress}-${i}`}
                pos={pos}
                symbol={
                  // P1: label by the market's own symbol (e.g. "SOL-PERP"), not the
                  // collateral token — sim-USDC is the SAME collateral across every
                  // market (see PLAYGROUND.md), so the old collateralMint lookup
                  // rendered "USDC/USD" for every position regardless of market.
                  pos.symbol
                    ? `${pos.symbol}/USD`
                    : tokenMetaMap.get(pos.collateralMint.toBase58())?.symbol
                    ? `${tokenMetaMap.get(pos.collateralMint.toBase58())!.symbol}/USD`
                    : `${pos.slabAddress.slice(0, 6)}…/USD`
                }
                decimals={tokenMetaMap.get(pos.collateralMint.toBase58())?.decimals ?? 6}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
