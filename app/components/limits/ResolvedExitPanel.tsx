"use client";

/**
 * Earn after resolution (P3 / F-4): explains why a redemption waits and lets anyone run the
 * permissionless terminal sweep. Pure view + a thin container over useResolvedExit.
 */
import { type FC } from "react";
import { COPY } from "@/lib/limits/copy";
import { summarizeResolvedExit, type ResolvedExitPlan } from "@/lib/limits/resolved-exit";
import type { ResolvedExitRun } from "@/lib/limits/resolved-exit-run";
import { useResolvedExit } from "@/hooks/useResolvedExit";
import { LimitsNotice } from "./LimitsRow";

export const ResolvedExitPanelView: FC<{
  plan: ResolvedExitPlan | null;
  running: boolean;
  lastRun: ResolvedExitRun | null;
  error: string | null;
  onRun: () => void;
  canRun: boolean;
}> = ({ plan, running, lastRun, error, onRun, canRun }) => {
  if (!plan || plan.phase === "not-resolved") return null;
  const s = summarizeResolvedExit(plan);
  const status =
    s.phase === "ready" ? COPY.resolvedExit.ready : s.phase === "owner-window" ? COPY.resolvedExit.ownerWindow(String(s.untilSlot ?? 0n)) : COPY.resolvedExit.sweep(s.runnable);
  return (
    <div data-testid="earn-resolved-exit-panel" data-phase={s.phase} className="mb-3 border border-[var(--border)] bg-[var(--panel-bg)] p-3">
      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">{COPY.resolvedExit.title}</p>
      <p data-testid="earn-resolved-exit-status" data-phase={s.phase} className="mt-1 text-[10px] leading-relaxed text-[var(--text-secondary)]">
        {status}
      </p>
      {s.harvestPending !== null && (
        <LimitsNotice tone="error" testId="earn-resolved-exit-blocker" data={{ kind: "harvest-pending" }}>
          {COPY.earnPlanBlocked["harvest-locked-after-resolve"]}
        </LimitsNotice>
      )}
      {s.escrowed > 0 && (
        <LimitsNotice tone="warning" testId="earn-resolved-exit-blocker" data={{ kind: "escrowed" }}>
          {COPY.resolvedExit.escrowed(s.escrowed)}
        </LimitsNotice>
      )}
      {s.locked > 0 && (
        <LimitsNotice tone="warning" testId="earn-resolved-exit-blocker" data={{ kind: "locked" }}>
          {COPY.resolvedExit.locked(s.locked)}
        </LimitsNotice>
      )}
      {s.phase !== "ready" && (
        <button
          type="button"
          data-testid="earn-resolved-exit"
          disabled={running || !canRun || s.runnable === 0}
          onClick={onRun}
          className="mt-2 w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/[0.15] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? COPY.resolvedExit.running : COPY.resolvedExit.button}
        </button>
      )}
      {lastRun && (
        <p data-testid="earn-resolved-exit-result" className="mt-2 text-[9px] text-[var(--text-secondary)]">
          {COPY.resolvedExit.result(lastRun.signatures.length, lastRun.refused.length)}
        </p>
      )}
      {error && (
        <p data-testid="earn-resolved-exit-error" className="mt-2 text-[9px] text-[var(--short)]">
          {error}
        </p>
      )}
    </div>
  );
};

export const ResolvedExitPanel: FC<{ slab: string | null; walletConnected: boolean; onDone?: () => void }> = ({ slab, walletConnected, onDone }) => {
  const x = useResolvedExit(slab);
  return (
    <ResolvedExitPanelView
      plan={x.plan}
      running={x.running}
      lastRun={x.lastRun}
      error={x.error}
      canRun={walletConnected}
      onRun={() => {
        void x.run().then(() => onDone?.()).catch(() => undefined);
      }}
    />
  );
};
