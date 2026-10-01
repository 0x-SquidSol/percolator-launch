"use client";

import { FC } from "react";
import { InfoIcon } from "@/components/ui/Tooltip";
import {
  LP_EXPOSURE_DEFAULT_BPS,
  LP_EXPOSURE_MAX_BPS,
  LP_EXPOSURE_MIN_BPS,
  LP_EXPOSURE_SAFE_BPS,
  LP_EXPOSURE_STEP_BPS,
  LP_SAFETY_MOVE_PCT,
  clampLpExposureBps,
} from "@/lib/matcher-params";

/**
 * The create wizard's position limit: the largest one-sided position the market's
 * liquidity will take on, written once into the matcher's max_inventory_abs
 * (lib/matcher-params.ts). Shown as one plain line; the creator can nudge it in
 * 0.25x steps between 0.25x and 2x of their liquidity. Under P3 the protocol pins it
 * (the wrapper holds a vault LP to 1x its junior equity), so it is read-only there.
 */

export interface PositionLimitFigures {
  /** Largest one-sided position, collateral units. */
  cap: number;
  /** What a LP_SAFETY_MOVE_PCT adverse move on a full cap costs the liquidity. */
  lossAtMove: number;
  /** Largest single trade (the matcher's max_fill_abs = cap / 4). */
  perTrade: number;
  /** True above LP_EXPOSURE_SAFE_BPS (the move could cost more than half the liquidity). */
  aboveSafe: boolean;
}

export function positionLimitFigures(liquidity: number, exposureBps: number): PositionLimitFigures {
  const lp = Number.isFinite(liquidity) && liquidity > 0 ? liquidity : 0;
  const bps = clampLpExposureBps(exposureBps);
  const cap = (lp * bps) / 10_000;
  return {
    cap,
    lossAtMove: (cap * LP_SAFETY_MOVE_PCT) / 100,
    perTrade: cap / 4,
    aboveSafe: bps > LP_EXPOSURE_SAFE_BPS,
  };
}

function money(v: number, symbol: string): string {
  const n = Math.round(v).toLocaleString();
  return /usd/i.test(symbol) ? `$${n}` : `${n} ${symbol}`;
}

const multiple = (bps: number) => `${(bps / 10_000).toString()}×`;

export interface PositionLimitProps {
  /** The creator's liquidity, display units. */
  liquidity: number;
  exposureBps: number;
  onChange?: (bps: number) => void;
  collateralSymbol: string;
  /** P3 launch: the protocol sets the limit (1x), nothing to choose. */
  fixedByProtocol?: boolean;
}

export const PositionLimit: FC<PositionLimitProps> = ({
  liquidity,
  exposureBps,
  onChange,
  collateralSymbol,
  fixedByProtocol,
}) => {
  const bps = fixedByProtocol ? LP_EXPOSURE_DEFAULT_BPS : clampLpExposureBps(exposureBps);
  const f = positionLimitFigures(liquidity, bps);
  const editable = !fixedByProtocol && !!onChange;
  const tip =
    `Your liquidity stops taking on more of one side once it holds ${money(f.cap, collateralSymbol)}, ` +
    `so a ${LP_SAFETY_MOVE_PCT}% price move against it costs about ${money(f.lossAtMove, collateralSymbol)} at most. ` +
    `Each trade can be up to ${money(f.perTrade, collateralSymbol)}. Set once at launch.`;

  return (
    <div data-testid="position-limit" className="mt-4 border-t border-[var(--border-subtle)] pt-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
          Largest position one trader can hold:{" "}
          <span
            data-testid="position-limit-value"
            className="text-[var(--text)]"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {money(f.cap, collateralSymbol)}
          </span>{" "}
          {!f.aboveSafe && (
            <span className="text-[var(--text-muted)]">
              (keeps your liquidity safe if the price moves {LP_SAFETY_MOVE_PCT}%)
            </span>
          )}
          <InfoIcon tooltip={tip} />
        </p>
        {editable && (
          <div className="flex flex-shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label="Lower position limit"
              disabled={bps <= LP_EXPOSURE_MIN_BPS}
              onClick={() => onChange!(bps - LP_EXPOSURE_STEP_BPS)}
              className="h-6 w-6 border border-[var(--border)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)] disabled:opacity-40"
            >
              −
            </button>
            <span
              data-testid="position-limit-multiple"
              className="w-10 text-center text-[11px] text-[var(--text)]"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {multiple(bps)}
            </span>
            <button
              type="button"
              aria-label="Raise position limit"
              disabled={bps >= LP_EXPOSURE_MAX_BPS}
              onClick={() => onChange!(bps + LP_EXPOSURE_STEP_BPS)}
              className="h-6 w-6 border border-[var(--border)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)] disabled:opacity-40"
            >
              +
            </button>
          </div>
        )}
      </div>
      {f.aboveSafe && (
        <p data-testid="position-limit-note" className="mt-1 text-[10px] leading-relaxed text-[var(--text-muted)]">
          At {multiple(bps)} your liquidity, a {LP_SAFETY_MOVE_PCT}% price move could cost it about{" "}
          {money(f.lossAtMove, collateralSymbol)}.
        </p>
      )}
    </div>
  );
};
