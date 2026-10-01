'use client';

/**
 * UX WP-4 (audit §3.6 item 4, user decision 2026-09-30): the pending withdrawal card. Replaces
 * "Pending Redemption {n} LP" / "Claim Redemption". It counts the cooldown down, then:
 *  - `armed` (the user requested in this page session): opens the payout signature by itself
 *    (sendTx pre-simulates it and bundles the repairs), so the two signatures feel like one flow;
 *  - otherwise (they came back later): "Finish withdrawal".
 */
import { useEffect, useRef, useState, type FC } from 'react';
import { StatusLine } from '@/components/ui/StatusLine';
import { EARN_WITHDRAW_COPY as C, SLOT_MS, fmtCountdown, type PendingPhase } from '@/lib/limits/earn-withdraw';

export interface EarnPendingWithdrawalProps {
  /** "12.50 USDC" (the estimate at the withdraw-side price), or the share count when unknown. */
  amountLabel: string;
  cooldownElapsed: boolean;
  cooldownRemainingSlots: bigint;
  /** Requested in this page session: open the payout prompt automatically when ready. */
  armed: boolean;
  disabled?: boolean;
  onCollect: () => Promise<void>;
  /** Re-read the ticket when the local countdown reaches 0 (the chain decides, not the clock). */
  onRefresh?: () => Promise<void> | void;
  /** A plain-language failure from the last payout attempt. */
  error?: string | null;
  /** The payout can only pay part right now: offer the max (re-request, then collect). */
  resize?: { label: string; body: string; onResize: () => Promise<void> } | null;
}

export const EarnPendingWithdrawal: FC<EarnPendingWithdrawalProps> = ({
  amountLabel,
  cooldownElapsed,
  cooldownRemainingSlots,
  armed,
  disabled = false,
  onCollect,
  onRefresh,
  error = null,
  resize = null,
}) => {
  const [now, setNow] = useState(() => Date.now());
  const [deadline, setDeadline] = useState(() => Date.now() + Number(cooldownRemainingSlots) * SLOT_MS);
  const [collecting, setCollecting] = useState(false);
  const autoFired = useRef(false);
  const lastRefresh = useRef(0);

  useEffect(() => {
    setDeadline(Date.now() + Number(cooldownRemainingSlots) * SLOT_MS);
  }, [cooldownRemainingSlots]);

  useEffect(() => {
    if (cooldownElapsed) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cooldownElapsed]);

  // The local clock ran out: ask the chain (at most every 2 s) until the ticket reads elapsed.
  const remainingMs = deadline - now;
  useEffect(() => {
    if (cooldownElapsed || remainingMs > 0 || !onRefresh) return;
    if (now - lastRefresh.current < 2000) return;
    lastRefresh.current = now;
    void onRefresh();
  }, [cooldownElapsed, remainingMs, now, onRefresh]);

  const collect = async () => {
    if (collecting || disabled) return;
    setCollecting(true);
    try {
      await onCollect();
    } finally {
      setCollecting(false);
    }
  };

  // Ready + requested in this session: open the payout prompt by itself, once.
  useEffect(() => {
    if (!cooldownElapsed || !armed || autoFired.current || disabled) return;
    autoFired.current = true;
    void collect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once when it becomes ready
  }, [cooldownElapsed, armed, disabled]);

  const phase: PendingPhase = collecting ? 'collecting' : cooldownElapsed ? 'ready' : 'counting';
  const body =
    phase === 'collecting'
      ? `${C.collecting} ${C.payoutPrompt}.`
      : phase === 'ready'
        ? C.ready
        : C.readyIn(fmtCountdown(Math.max(0, remainingMs)));

  return (
    <div
      data-testid="earn-pending-withdrawal"
      data-phase={phase}
      className="mx-5 mt-5 border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3"
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">{C.pendingTitle(amountLabel)}</p>
      <p data-testid="earn-pending-countdown" className="mt-1 flex items-center gap-1.5 font-mono text-[13px] tabular-nums text-[var(--text)]">
        {phase !== 'ready' && (
          <span aria-hidden="true" className="inline-block h-[6px] w-[6px] animate-pulse rounded-full bg-[var(--text-muted)]" />
        )}
        {body}
      </p>
      {error && (
        <div className="mt-2">
          <StatusLine message={{ kind: 'earn-payout-refused', variant: 'error', title: 'Payout not sent', body: error }} legacyTestId="earn-error" />
        </div>
      )}
      {resize && (
        <div className="mt-2">
          <StatusLine
            message={{ kind: 'earn-max-available', variant: 'paused', title: C.maxAvailableTitle, body: resize.body, action: { id: 'use-max', label: resize.label } }}
            onAction={() => void resize.onResize()}
          />
        </div>
      )}
      {phase === 'ready' && !resize && (
        <button
          type="button"
          data-testid="earn-withdraw-execute"
          onClick={() => void collect()}
          disabled={disabled}
          className="mt-3 w-full bg-[var(--accent)] py-2.5 text-[12px] font-bold uppercase tracking-[0.12em] text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {C.finish}
        </button>
      )}
    </div>
  );
};
