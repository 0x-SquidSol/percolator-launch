'use client';

import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { bigintRatio } from "@/lib/formatters";
import { estimateLpEarnedSincePar } from "@/lib/lp-earned";
import { ShimmerSkeleton } from '@/components/ui/ShimmerSkeleton';


interface LpPositionDashboardProps {
  /** User's LP token balance (raw) */
  userLpBalance: bigint;
  /** Total LP supply */
  lpSupply: bigint;
  /** Total vault balance (raw) */
  vaultBalance: bigint;
  /** Decimals for collateral */
  decimals: number;
  /** Decimals for the LP token mint — NOT necessarily the same as collateral decimals */
  lpDecimals: number;
  /** Collateral symbol */
  collateralSymbol: string;
  /** Redemption rate (e6) */
  redemptionRateE6: bigint;
  /** Loading */
  loading: boolean;
}

export function LpPositionDashboard({
  userLpBalance,
  lpSupply,
  vaultBalance,
  decimals,
  lpDecimals,
  collateralSymbol,
  redemptionRateE6,
  loading,
}: LpPositionDashboardProps) {
  const divisor = 10n ** BigInt(decimals);
  const hasPosition = userLpBalance > 0n;

  // Calculate user's share
  const userSharePct =
    lpSupply > 0n
      ? Number((userLpBalance * 10000n) / lpSupply) / 100
      : 0;

  const userRedeemableValue =
    lpSupply > 0n ? (userLpBalance * vaultBalance) / lpSupply : 0n;

  // #2324: both sides can be large while the quotient is small, so scale inside
  // bigint arithmetic rather than converting each side to a float first.
  const userRedeemableFloat = bigintRatio(userRedeemableValue, divisor) ?? 0;

  // Estimated earnings = appreciation of the position's shares since par. This is
  // an ESTIMATE, not a settled P&L: the fee stream that lifts the share price is
  // real and auto-paid on withdraw (no claim), but the on-chain deposit record
  // holds no cost basis, so we can only measure growth from par — exact for a
  // par-entry deposit, an upper bound for a later one. See lib/lp-earned.ts.
  const earned = estimateLpEarnedSincePar(userRedeemableValue, redemptionRateE6);
  const earnedFloat = bigintRatio(earned.earnedAtoms, divisor) ?? 0;

  if (loading) {
    return (
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-5 hud-corners">
        <ShimmerSkeleton className="h-5 w-36 mb-6" />
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-2">
              <ShimmerSkeleton className="h-3 w-20" />
              <ShimmerSkeleton className="h-6 w-24" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm overflow-hidden hud-corners">
      <div className="h-px bg-gradient-to-r from-transparent via-[var(--cyan)]/30 to-transparent" />

      <div className="p-5">
        <div className="flex items-center justify-between mb-5">
          <h3
            className="text-sm font-medium text-[var(--text)]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Your LP Position
          </h3>
          {hasPosition && (
            <span className="text-[10px] px-2 py-0.5 rounded-sm bg-[var(--cyan)]/10 border border-[var(--cyan)]/20 text-[var(--cyan)]">
              Active
            </span>
          )}
        </div>

        {!hasPosition ? (
          <div className="text-center py-6">
            <div className="text-2xl mb-2">📊</div>
            <p className="text-[13px] text-[var(--text-secondary)]">
              No active LP position
            </p>
            <p className="text-[11px] text-[var(--text-muted)] mt-1">
              Deposit to start earning fees
            </p>
          </div>
        ) : (
          <>
            {/* Main value */}
            <div className="mb-5 p-4 bg-[var(--bg)] border border-[var(--border)] rounded-sm">
              <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)] mb-1">
                Position Value
              </div>
              <div className="flex items-baseline gap-2">
                <AnimatedNumber
                  value={userRedeemableFloat}
                  decimals={4}
                  className="text-2xl font-bold text-[var(--text)]"
                />
                <span className="text-sm text-[var(--text-secondary)]">
                  {collateralSymbol}
                </span>
              </div>
              {/* Estimated earnings, right under the headline value. Labelled as
                  an estimate on purpose — see the earned computation above and
                  lib/lp-earned.ts for why an exact per-user figure isn't on-chain. */}
              <div
                className="mt-2 flex items-center gap-1.5 text-[11px] tabular-nums cursor-help"
                title={
                  earned.hasGain
                    ? `Estimated fees earned: your shares are worth ${earned.gainPct.toFixed(2)}% more than par (1.00×). Assumes you deposited at par — the exact figure needs per-deposit cost basis (coming soon). Fees compound into share value and are paid automatically on withdraw; nothing to claim.`
                    : `No fees accrued to this vault since par (1.00×) yet. Fees compound into your share value and are paid automatically on withdraw — nothing to claim.`
                }
              >
                <span className="uppercase tracking-[0.15em] text-[9px] text-[var(--text-secondary)] underline decoration-dotted decoration-[var(--text-muted)]">
                  Est. Earned
                </span>
                <span
                  className="font-mono font-semibold"
                  style={{ color: earned.hasGain ? 'var(--cyan)' : 'var(--text-muted)' }}
                >
                  {earned.hasGain ? '+' : ''}
                  {earnedFloat.toFixed(4)} {collateralSymbol}
                  {earned.hasGain ? ` (+${earned.gainPct.toFixed(2)}%)` : ''}
                </span>
              </div>
            </div>

            {/* Metrics grid */}
            <div className="grid grid-cols-2 gap-4">
              <MetricCell
                label="LP Tokens"
                value={formatRaw(userLpBalance, lpDecimals)}
              />
              <MetricCell
                label="Pool Share"
                value={`${userSharePct.toFixed(2)}%`}
                highlight
              />
              {/* "Share Value" — how much 1 LP token redeems for. Sourced from the
                  on-chain redemption rate (vaultTotalAtoms / lpSupply, read fresh
                  by useInsuranceLP) rather than recomputed locally — the two used
                  to be shown as separate cells that could visibly disagree. */}
              <MetricCell
                label="Share Value"
                value={`${(Number(redemptionRateE6) / 1_000_000).toFixed(4)} ${collateralSymbol}`}
              />
              <MetricCell
                label="Redemption Rate"
                value={`${(Number(redemptionRateE6) / 1_000_000).toFixed(4)}`}
              />
              <MetricCell
                label="Total Vault"
                value={`${formatRaw(vaultBalance, decimals)} ${collateralSymbol}`}
              />
            </div>

            <p className="mt-4 text-[10px] leading-relaxed text-[var(--text-muted)]">
              <span className="text-[var(--text-secondary)]">Est. Earned</span> tracks
              your share-price growth since par (1.00×) — an estimate that assumes a
              par-entry deposit. Fees compound into your share value and are paid
              automatically when you withdraw; there is nothing to claim.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function MetricCell({
  label,
  value,
  highlight = false,
  color,
  tooltip,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  color?: string;
  tooltip?: string;
}) {
  return (
    <div>
      <div
        className={`text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)] mb-0.5 ${
          tooltip ? 'cursor-help underline decoration-dotted decoration-[var(--text-muted)]' : ''
        }`}
        title={tooltip}
      >
        {label}
      </div>
      <div
        className={`text-sm font-mono tabular-nums ${
          highlight ? 'font-semibold' : ''
        }`}
        style={{ color: color ?? (highlight ? 'var(--accent)' : 'var(--text)') }}
      >
        {value}
      </div>
    </div>
  );
}

function formatRaw(raw: bigint, decimals: number): string {
  if (raw <= 0n) return '0';
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}
