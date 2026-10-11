/**
 * Copy for a v2.2 trade refused Custom(9) (Q-1 / Q-6). Kept import-free so lib/errorMessages.ts can
 * use it without pulling the decoders (lib/v22/trade-refusal-9.ts has the diagnosis).
 */
/** v2.2 wrapper `WRAPPER_MAX_PORTFOLIO_ASSETS` (cap 4; InitMarket with 5 refused 14 on devnet). */
export const V22_MAX_POSITIONS = 4;

export type V22Custom9Cause = "position-cap" | "price-limit" | "fee-cap" | "undetermined";

export const V22_CUSTOM9_COPY: Record<V22Custom9Cause, string> = {
  "position-cap": "This account already has the maximum of 4 positions. Close one of them to open a position in another asset. Nothing changed.",
  "price-limit":
    "The market's fill price moved past your price limit, so the order was not placed and nothing changed. Try again, or allow a little more slippage.",
  "fee-cap": "The market's trading fee changed while the order was being sent, so it was not placed and nothing changed. Try again.",
  undetermined: "The program refused this order before it filled, so nothing changed. Try again in a moment.",
};

/** Immediate (pre-diagnosis) line for a v2.2 trade refused 9: no slippage guess, no jargon. */
export const V22_CUSTOM9_GENERIC = V22_CUSTOM9_COPY.undetermined;

/** Q-6: the ticket blocks a 5th asset up front (the program refuses it 49 or 9 depending on margin). */
export const V22_POSITION_CAP_COPY = "This account already has the maximum of 4 positions. Close one to open a position in another asset.";

/** Pure: would an OPEN on `assetIndex` be a 5th asset for an account holding `heldAssets`? */
export function positionCapBlocksOpen(heldAssets: readonly number[], assetIndex: number): boolean {
  return !heldAssets.includes(assetIndex) && new Set(heldAssets).size >= V22_MAX_POSITIONS;
}
