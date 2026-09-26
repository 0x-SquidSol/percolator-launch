"use client";

/**
 * "Fees earned" section for /my-markets.
 *
 * Creator fees were claimable ONLY from a panel buried inside each row's expand
 * drawer: no totals, no per-market figure on the surface, and a creator with
 * eight markets had to open eight drawers to find out whether they had earned
 * anything. This is the surface answer — per market, with a total, and a single
 * claim-all.
 *
 * THE DISPLAY RULE, which is the whole point: a balance that could not be READ
 * renders as "unavailable", never as a zero. `/api/markets/[slab]`'s Supabase
 * branch used to return no creator-fee field at all, and the row collapsed that
 * to `0n` — so every creator was told they had earned nothing. An unknown
 * balance is also excluded from the total and from claim-all, because tag 90 is
 * exact-amount and would reject a guess.
 */

import { FC, useMemo } from "react";
import type { CreatedMarket } from "@/hooks/useCreatedMarkets";
import type { CreatorMarketDetail } from "./types";
import { unitScaleToDecimals } from "./types";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useClaimCreatorFees } from "@/hooks/useClaimCreatorFees";
import {
  classifyClaimable,
  summarizeCreatorFees,
  claimAllTargets,
  type CreatorFeeEntry,
} from "@/lib/creator-fee-summary";
import { resolveIdentity, type ResolvedIdentity } from "@/lib/bulk-identity";
import { explorerTxUrl } from "@/lib/config";
import { Tooltip } from "@/components/ui/Tooltip";

interface CreatorFeesPanelProps {
  markets: CreatedMarket[];
  details: Record<string, CreatorMarketDetail>;
  identities: Record<string, ResolvedIdentity>;
  /** Re-read balances after a successful claim. */
  onClaimed?: () => void;
}

const fmt = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export const CreatorFeesPanel: FC<CreatorFeesPanelProps> = ({
  markets,
  details,
  identities,
  onClaimed,
}) => {
  const wallet = useWalletCompat();
  const { claim, busy, progress, outcomes } = useClaimCreatorFees();
  const connected = wallet.publicKey?.toBase58() ?? null;

  const entries = useMemo<(CreatorFeeEntry & { label: string })[]>(
    () =>
      markets.map((m) => {
        const slab = m.slabAddress.toBase58();
        const detail = details[slab] ?? null;
        const identity = resolveIdentity(detail, identities[slab] ?? null);
        const cfg = m.configV17 as { collateralMint?: { toBase58: () => string }; unitScale?: number } | undefined;
        return {
          slab,
          label: identity.symbol ?? m.label,
          claimable: classifyClaimable(detail?.creator_fee_claimable_atoms),
          collateralMint: cfg?.collateralMint?.toBase58() ?? null,
          decimals: unitScaleToDecimals(cfg?.unitScale ?? m.config?.unitScale),
          // tag 90 accepts asset 0's asset_admin only. Fails closed: an unknown
          // authority is NOT "probably me".
          isClaimAuthority:
            connected != null &&
            detail?.creator_fee_authority != null &&
            detail.creator_fee_authority === connected,
        };
      }),
    [markets, details, identities, connected],
  );

  const summary = useMemo(() => summarizeCreatorFees(entries), [entries]);
  const targets = useMemo(() => claimAllTargets(entries), [entries]);
  const outcomeBySlab = useMemo(
    () => new Map(outcomes.map((o) => [o.slab, o])),
    [outcomes],
  );

  if (markets.length === 0) return null;

  const runClaim = async (slabs: readonly string[]) => {
    const results = await claim(slabs);
    if (results.some((r) => r.signature)) onClaimed?.();
  };

  return (
    <div className="mb-8 border border-[var(--border)] bg-[var(--panel-bg)]">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[var(--border)]/60 px-4 py-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text)]">
            Fees Earned
          </p>
          <p className="mt-1 text-[10px] text-[var(--text-dim)]">
            Your share of every trade on your markets. Accrues on chain and is
            claimed manually — nothing is sent automatically.
          </p>
        </div>

        <div className="text-right">
          {summary.allUnknown ? (
            // NOT "$0.00": nothing could be read, so there is no total to show.
            <p className="text-[12px] text-[var(--text-dim)]">balance unavailable</p>
          ) : summary.totalsByMint.length === 0 ? (
            <p className="text-[12px] text-[var(--text-secondary)]">no fees accrued yet</p>
          ) : (
            summary.totalsByMint.map((t) => (
              <p
                key={t.collateralMint}
                className="text-lg font-bold tabular-nums text-[var(--text)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {fmt(t.total)}
                {summary.totalsByMint.length > 1 && (
                  <span className="ml-1 text-[10px] font-normal text-[var(--text-dim)]">
                    {t.collateralMint.slice(0, 4)}…
                  </span>
                )}
              </p>
            ))
          )}
          {summary.unknownMarkets > 0 && !summary.allUnknown && (
            // The total is real for what was readable — say so rather than
            // presenting it as covering every market.
            <p className="text-[10px] text-[var(--warning)]">
              {summary.unknownMarkets} of {markets.length} unreadable, not included
            </p>
          )}
        </div>
      </div>

      {targets.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)]/40 bg-[var(--accent)]/[0.03] px-4 py-2.5">
          <p className="text-[11px] text-[var(--text-secondary)]">
            {summary.claimableMarkets === 1
              ? "1 market has fees you can claim"
              : `${summary.claimableMarkets} markets have fees you can claim`}
            {summary.marketsWithFees > summary.claimableMarkets && (
              <span className="ml-1 text-[var(--text-dim)]">
                ({summary.marketsWithFees - summary.claimableMarkets} earned on a market whose admin
                is another wallet)
              </span>
            )}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void runClaim(targets)}
            className="shrink-0 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/[0.15] disabled:opacity-50"
          >
            {busy
              ? `claiming ${progress.done}/${progress.total}…`
              : `claim all (${targets.length})`}
          </button>
        </div>
      )}

      <div className="divide-y divide-[var(--border)]/30">
        {entries.map((e) => {
          const outcome = outcomeBySlab.get(e.slab);
          const claimingThis = busy && progress.current === e.slab;
          return (
            <div key={e.slab} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="min-w-[80px] text-[11px] font-semibold text-[var(--text)]">
                {e.label}
              </span>

              <span
                className="min-w-[90px] text-[12px] tabular-nums text-[var(--text)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {e.claimable.kind === "unknown" ? (
                  <Tooltip text="This market's creator-fee counter could not be read, so it is left out of the total. It is not a zero.">
                    <span className="text-[var(--text-dim)]">unavailable</span>
                  </Tooltip>
                ) : e.claimable.kind === "none" ? (
                  <span className="text-[var(--text-dim)]">0.00</span>
                ) : (
                  fmt(Number(e.claimable.atoms) / 10 ** e.decimals)
                )}
              </span>

              <div className="ml-auto flex items-center gap-2">
                {outcome?.signature && (
                  <a
                    href={explorerTxUrl(outcome.signature)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-[var(--long)] underline decoration-dotted"
                  >
                    claimed
                  </a>
                )}
                {outcome?.error && (
                  <span className="max-w-[260px] text-[10px] text-[var(--short)]">
                    {outcome.error}
                  </span>
                )}

                {e.claimable.kind === "claimable" && e.isClaimAuthority && !outcome?.signature && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runClaim([e.slab])}
                    className="border border-[var(--accent)]/30 px-2.5 py-1 text-[10px] uppercase tracking-[0.1em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10 disabled:opacity-40"
                  >
                    {claimingThis ? "claiming…" : "claim"}
                  </button>
                )}

                {e.claimable.kind === "claimable" && !e.isClaimAuthority && (
                  <Tooltip text="Only this market's asset admin can claim its fees. That is a different wallet — connect it to claim.">
                    <span className="text-[10px] text-[var(--text-dim)]">another wallet claims</span>
                  </Tooltip>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
