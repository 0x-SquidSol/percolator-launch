/**
 * User-facing copy for the limits UI (plan §2). Exported so tests pin it and
 * so the error map, the ticket and the E2E lane share one wording.
 * No dependency on the rest of the app (imported by lib/errorMessages.ts).
 */
import { P2_ERR, P3_ERR } from "./constants";

export const COPY = {
  bandTooltip: "Fills must execute within this distance of the oracle mark. Outside it the trade is refused.",
  bandOutOfRange: "The quote for this size is outside the market's price band. Reduce the size.",
  reason: {
    "lp-exposure": (k: string) => `Limited by the LP's capital: the liquidity provider can hold at most ${k}× its equity.`,
    "side-oi": (side: string) => `Limited by the protocol cap on total ${side} open interest.`,
    "matcher-fill": () => "Limited by the market's per-trade size.",
    "matcher-inventory": () => "Limited by how much net exposure the LP will carry.",
    "lp-halt": () => "The LP is at its capital floor: only trades that reduce its exposure can fill.",
    none: () => "",
  },
  clamped: (max: string, sym: string, reason: string) => `Size reduced to ${max} ${sym}. ${reason}`.trim(),
  zeroFill: "The LP had no room for this trade when it landed. Your position did not change and no trading fee was charged.",
  partialFill: (filled: string, requested: string, sym: string) => `Partially filled: ${filled} of ${requested} ${sym}.`,
  halted: (side: string) =>
    `Opening ${side} is paused: the market's liquidity provider is at its capital floor. Reducing and closing positions still work.`,
  sameOwner:
    "This wallet owns this market's liquidity or created the market, so it can't trade against it. Use a different wallet.",
  limitsUnavailable: "Limits unavailable. Showing no cap.",
  quoteSettlesAtMark:
    "On this program version fills settle at the mark price. The quote above only decides how much can fill and whether your slippage limit passes.",
  quoteCharged: "The quoted price is charged: the difference from the mark is paid to the market's liquidity.",
  quoteClipped: (fill: string) => `Quote caps this trade at ${fill}.`,
  quoteSlippage: (s: string) =>
    `Your slippage limit (${s}) is tighter than the quote; the trade would be refused. Raise slippage or reduce size.`,
  feeEstimate: "Fee estimate; the final fee is set when the trade lands.",
  legacyQuote: (bps: string) => `Quote: within ${bps} of mark.`,
  skew: (dir: "long" | "short" | "flat", size: string, sym: string) =>
    dir === "flat" ? "Book skew: balanced" : `Book skew: traders net ${dir} ${size} ${sym} (LP ${dir === "long" ? "short" : "long"})`,
  riskDisclosure:
    "Earn deposits are the senior tranche of the vault that is this market's liquidity provider. Trader profits are paid first from the creator's junior tranche; once it is exhausted, from Earn deposits. Share price can fall. Withdrawals can be delayed while the LP holds open positions.",
  withdrawReceive: (amt: string) => `You receive ≈ ${amt}.`,
  withdrawImpaired: (senior: string) =>
    `The senior tranche is impaired; you receive your share of ${senior}, below principal.`,
  withdrawIlliquid:
    "Part of the vault's value is in the LP's open positions. Your redemption may wait for a recall (permissionless) or the keeper.",
  depositsPausedImpaired: "Deposits are paused while the senior tranche is impaired.",
  apyInsufficient: "Needs 24 h of fee history",
  resolvedVault: "This market is resolved. Vault settlement for resolved markets is not available yet.",
  fundingPay: (amt: string) => `Skew funding: you pay ${amt}/h`,
  fundingReceive: (amt: string) => `Skew funding: you receive ${amt}/h`,
  liqDrift: (delta: string) =>
    `At the current skew rate your liquidation price moves ≈ ${delta} per day. Add margin or reduce to hold it.`,
  stepDown: (x: string, side: string, crowd: string, base: string) =>
    `Max leverage is ${x}× for new ${side} positions while the book is crowded (${crowd} of the cap). The other side keeps ${base}×.`,
  wizardRequirement: (floor: string) =>
    `Your junior tranche is first-loss capital. Traders' profits are paid from it before Earn depositors lose anything. It can't be withdrawn while the LP holds positions, or below ${floor} of Earn deposits.`,
  wizardAfterLaunch: "Junior deposit is added after launch.",
  closeRebooked: "Fees were re-booked; press Close again to finish.",
  closeHalted:
    "The market's LP is at its capital floor and your close would add to its exposure, so the program may refuse it until the LP recovers. Closes on the other side of the book still work.",
} as const;

/** Matcher v2 error copy (Custom 8002..8005, matcher program only). */
export const P2_ERROR_COPY: Record<number, string> = {
  [P2_ERR.ERR_STALE_MARK]: "The price feed is stale, so new positions are paused. Closing still works. Try again shortly.",
  [P2_ERR.ERR_MARK_SLOT_IN_FUTURE]: "The price feed returned an invalid timestamp. Try again in a few seconds.",
  [P2_ERR.ERR_ASSET_MISMATCH]: "This market's pricing engine is misconfigured (bound to another asset). Report this market.",
  [P2_ERR.ERR_OWNER_PROOF_MISMATCH]: "Only the market's LP owner can change its pricing settings.",
};

/** P3 wrapper error copy, keyed by NAME (ordinals are provisional — see constants.ts). */
export const P3_ERROR_COPY_BY_NAME: Record<keyof typeof P3_ERR, string> = {
  VaultLpAlreadyBound: "This market's Earn vault already owns its LP.",
  VaultLpNotBound: "This market's Earn vault does not own an LP yet.",
  VaultLpSeniorImpaired: COPY.depositsPausedImpaired,
  VaultLpJuniorWithdrawRefused:
    "Junior withdrawal refused: it would take the junior below its floor, or the vault's backing does not cover Earn deposits right now.",
  VaultLpRecallRefused: "Nothing to recall: the vault's backing already covers Earn deposits.",
  VaultLpExclusiveCounterparty:
    "This market's LP is the Earn vault. New positions can only trade against it; reducing an old position still works.",
  VaultLpLeverageStepDown:
    "Leverage too high for this side while the book is crowded. Lower leverage or trade the other side.",
  VaultLpBoundCannotClose: "This vault owns the market's LP and can't be closed.",
};

/** P3 copy re-keyed by the CURRENT provisional ordinals. */
export function p3ErrorCopyByCode(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [name, code] of Object.entries(P3_ERR) as [keyof typeof P3_ERR, number][]) {
    out[code] = P3_ERROR_COPY_BY_NAME[name];
  }
  return out;
}
