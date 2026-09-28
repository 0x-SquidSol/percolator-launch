/**
 * Position notional from margin and leverage — the single definition.
 *
 * GH#2616. This computation existed twice, written out identically in
 * `OrderTicket` and in the `TradeConfirmationModal` it renders. When the
 * fractional-leverage fix was applied it reached only one of them, so the modal
 * kept doing `margin * BigInt(leverage)` and threw
 *
 *   RangeError: The number 4.5 cannot be converted to a BigInt because it is
 *   not an integer
 *
 * on every market created at a fractional leverage — the error boundary showed
 * "something broke in OrderTicket" and the market could not be traded.
 *
 * Copying the corrected expression into the second call site would have fixed
 * that instance and left the same trap set: two identical formulas, nothing
 * keeping them identical. The confirmation screen quietly disagreeing with the
 * order it submits is a worse failure than the crash, because it is silent. One
 * function, two callers.
 */

/**
 * Scale factor for the fractional part of `leverage`. Two decimals is exactly
 * what the UI can produce: `OrderTicket` derives its ceiling as
 * `Math.floor((10_000 / initialMarginBps) * 100) / 100` and offers that value
 * itself as the top snap point, so 2dp is both the finest and the widest case.
 */
const SCALE = 100;
const SCALE_BIG = 100n;

/**
 * Notional in collateral base units.
 *
 * `Math.round`, NOT floor/trunc, and the difference is reachable: a 2-decimal
 * leverage scaled by 100 is frequently not an exact integer in binary floating
 * point. Sweeping `initialMarginBps` 1000-5000, 619 of 4001 values (15.5%)
 * produce one — e.g. bps 1005 gives leverage 9.95, and `9.95 * 100` is
 * `994.9999999999999`. Flooring that yields 994 and silently under-sizes the
 * notional by 0.1%; rounding yields the intended 995.
 *
 * Non-finite or negative leverage returns 0n rather than throwing. `BigInt(NaN)`
 * raises the same RangeError this whole function exists to prevent, and this is
 * an exported component's prop: a caller that has not clamped its input should
 * get a zero-size quote, not a crashed trade page.
 */
export function computeNotionalNative(marginNative: bigint, leverage: number): bigint {
  if (!Number.isFinite(leverage) || leverage <= 0) return 0n;
  if (marginNative <= 0n) return 0n;
  return (marginNative * BigInt(Math.round(leverage * SCALE))) / SCALE_BIG;
}
