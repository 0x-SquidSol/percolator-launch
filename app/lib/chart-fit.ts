/**
 * When to auto-fit the trading chart's viewport to its data.
 *
 * The series-rebuild effect fits the viewport (`timeScale().fitContent()`)
 * exactly once per (chart-kind, timeframe, data-source) combo, then leaves it
 * alone so the user's pan/zoom survives the 30–60s data polls. Deciding *which*
 * render owns that one fit is subtle: a timeframe switch re-renders
 * synchronously while the candle hook is still serving the PREVIOUS timeframe's
 * data (it re-fetches in a post-render effect), so the effect fires once with
 * stale data before the new data lands. Fitting on that transitional render
 * fits the viewport to the wrong bar count and, by marking the combo as fitted,
 * suppresses the real fit once the correct data arrives — leaving the series
 * squished into a fraction of the canvas (a 1d chart drawn at 4h bar-spacing;
 * the visible symptom after a 1d → 4h → 1d round-trip).
 *
 * Pure and dependency-free (no `lightweight-charts` / React) so it can be
 * unit-tested exhaustively, mirroring `chart-zoom.ts`.
 */

export interface FitDecisionInput {
  /** The `kind:timeframe:source` key last committed as fitted. */
  prevFitKey: string;
  /** The same key for the render being evaluated. */
  nextFitKey: string;
  /**
   * Whether a series was actually built from renderable data this render. A
   * cleared/empty source breaks out of the series switch without building a
   * series, and must not consume the combo's one fit — otherwise the later
   * real-data render is denied it.
   */
  built: boolean;
  /** The series-data array reference fitted last time (candleData or lineData). */
  prevFitData: unknown;
  /**
   * The series-data array reference for this render. On the transitional render
   * it is still the previous timeframe's array (=== prevFitData); it only
   * advances once the new timeframe's data has landed.
   */
  nextFitData: unknown;
}

/**
 * True when this render should call `fitContent()` and claim the combo's fit.
 *
 * Requires all three:
 *  - a NEW combo (`prevFitKey !== nextFitKey`) — same-combo polls never refit,
 *    which is what preserves the user's pan/zoom;
 *  - a series actually built this render (`built`) — a cleared/empty source
 *    must not consume the fit;
 *  - the data reference to have advanced past the last fitted one
 *    (`prevFitData !== nextFitData`) — so the fit lands on the render carrying
 *    the new timeframe's data, not the transitional render still holding the
 *    old frame.
 */
export function shouldFitViewport(input: FitDecisionInput): boolean {
  return (
    input.prevFitKey !== input.nextFitKey &&
    input.built &&
    input.prevFitData !== input.nextFitData
  );
}
