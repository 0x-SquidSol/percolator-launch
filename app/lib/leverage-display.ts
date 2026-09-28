export const ORDER_LEVERAGE_LABEL = "Order Lev.";
export const RISK_LEVERAGE_LABEL = "Risk Lev.";

export const ORDER_LEVERAGE_TITLE =
  "Order leverage is the slider value used to size this trade.";

export const RISK_LEVERAGE_TITLE =
  "Risk leverage is this market account's effective exposure: position notional divided by collateral in this slab account. Extra collateral lowers liquidation risk.";

export function formatLeverageValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (Number.isInteger(value)) return value.toString();
  // Up to 2dp, trailing zero trimmed. GH#2628: this was toFixed(1), which could
  // not show a value the rest of the pipeline can produce — a market's max is
  // derived to 2dp, so a 6.66x market's own preset button read "6.7x" while
  // applying 6.66, and a typed 4.56 displayed as "4.6". A control must not
  // apply a number it cannot show.
  return value.toFixed(2).replace(/0$/, "");
}

export function formatLeverage(value: number): string {
  return `${formatLeverageValue(value)}x`;
}
