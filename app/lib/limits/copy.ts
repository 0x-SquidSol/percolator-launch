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
    "same-owner": () => "This wallet owns the LP or created the market, so it can only reduce or close its position.",
    "vault-lp-exposure": (lev: string) => `Limited by the Earn vault LP's cap: at most ${lev}× the creator's first-loss capital.`,
    none: () => "",
  },
  clamped: (max: string, sym: string, reason: string) => `Size reduced to ${max} ${sym}. ${reason}`.trim(),
  zeroFill: "The LP had no room for this trade when it landed. Your position did not change and no trading fee was charged.",
  partialFill: (filled: string, requested: string, sym: string) => `Partially filled: ${filled} of ${requested} ${sym}.`,
  halted: (side: string) =>
    `Opening ${side} is paused: the market's liquidity provider is at its capital floor. Trades that reduce the LP's exposure still fill.`,
  // P1 99165722 (F-7): a close that would GROW a halted / capped LP is refused (69) or clipped.
  closeHalted:
    "The market's LP is at its capital floor and your close would add to its exposure, so the program refuses it until the LP is re-funded or the book rebalances. Closes that reduce the LP's exposure still work.",
  closeCapped: (max: string, sym: string) =>
    `The LP can only take ${max} ${sym} of this close before it reaches its exposure cap; a larger close fills partially or is refused. Close in parts, or wait for the book to rebalance.`,
  sameOwner:
    "This wallet owns this market's liquidity or created the market, so it can only close positions here, not open or add to them. Use a different wallet to trade.",
  limitsUnavailable: "Limits unavailable. Showing no cap.",
  quoteSettlesAtMark:
    "On this program version fills settle at the mark price. The quote above only decides how much can fill and whether your slippage limit passes.",
  quoteCharged: "The quoted price is charged: the difference from the mark is paid to the market's LP as a fee. Your signature caps it at the maximum shown.",
  feeCapTooltip:
    "The most this trade can charge you: base fee + the quote's fee + a small slippage margin, so a quote that moves slightly before landing still fills. You pay only what the matcher actually requests, never more than this. If the request exceeds it, the trade is refused and nothing is charged.",
  feeOverProtocolMax: (bps: string) => `The quote's fee is above this market's protocol maximum (${bps} bps), so the trade would be refused. Reduce the size.`,
  feeOverMarketMax: "The quote's fee plus the base fee is above this market's maximum trading fee, so the trade would be refused. Reduce the size.",
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
  valuationStale: "Vault value needs a refresh (the LP holds positions and its health certificate is stale).",
  excludesUncrankedFees: "excludes uncranked fees",
  apyInsufficient: "Needs 24 h of fee history",
  resolvedVault: "This market is resolved. Vault settlement for resolved markets is not available yet.",
  fundingPay: (amt: string) => `Skew funding: you pay ${amt}/h`,
  fundingReceive: (amt: string) => `Skew funding: you receive ${amt}/h`,
  liqDrift: (delta: string) =>
    `At the current skew rate your liquidation price moves ≈ ${delta} per day. Add margin or reduce to hold it.`,
  stepDown: (x: string, side: string, crowd: string, base: string) =>
    `Max leverage is ${x}× for new ${side} positions while the book is crowded (${crowd} of the cap). The other side keeps ${base}×.`,
  wizardRequirement: (floor: string) =>
    `Your junior tranche is first-loss capital. Losses hit the creator's junior first, then Earn depositors pro rata. Winning trades are always paid in full. It can't be withdrawn while the LP holds positions, or below ${floor} of Earn deposits.`,
  wizardAfterLaunch: "Junior deposit is added after launch.",
  closeRebooked: "Fees were re-booked; press Close again to finish.",
  closeZeroFill:
    "Market at capacity — no fill. Your close landed but the LP had no room to take it, so your position did not change. Try a smaller percentage or again shortly.",
  rebalanceZeroFill:
    "Nothing could be closed yet: this market is reduce-only after a bankruptcy and the other side has no open interest left to match. Try again as positions on the other side close.",
  rebalancePartial: (filled: string, requested: string) =>
    `Partially closed: ${filled} of ${requested}. The market is reduce-only after a bankruptcy; the rest can close as the other side exits.`,
  adlReduceOnlyTitle: "Reduce-only — recovering from a bankruptcy",
  adlCloseRoute:
    "Your close is sent as a unilateral exit you sign yourself (RebalanceReduce), so it does not depend on the market's LP. It may close only part of the position if the other side has little open interest left.",
  adlReduceOnly:
    "A bankrupt position was spread across this side of the market, so new positions are paused until one side has closed out. Closing works: your close is sent as a unilateral exit you sign yourself. The market reopens on its own once positions close; no admin step is needed.",
  reclaimCleanup: {
    "progress-only": () =>
      "Your position on this market is still settling after resolution (its counterparty has not settled yet). Try the reclaim again in a moment.",
    refused: () => "One of your accounts on this market could not be closed yet, so the market cannot be reclaimed. Try again in a moment.",
    "others-remain": (n: string) =>
      `Your accounts are closed, but ${n} other account${n === "1" ? "" : "s"} still hold a position or balance on this market, so it cannot be reclaimed until they close.`,
  } as const,
  juniorResolvedExplain:
    "Earn depositors are paid first: each redeems up to their claim from the vault's backing. You can take what is left above their remaining claim once the market is fully closed out.",
  adlExitTrapped:
    "The other side of this market has fully closed, and your position cannot settle until the drained side is reset. Nothing was sent. Try again in a moment, after the next market crank.",
  closePartial: (filled: string, requested: string) => `Partially closed: ${filled} of ${requested}. The rest of your position is still open.`,
  resolvedExit: {
    title: "This market has resolved",
    ready: "Every position on this market is closed, so Earn redemptions pay out now. Use Withdraw below.",
    sweep: (n: number) =>
      `Earn pays out once every position on the market is closed. ${n} step${n === 1 ? "" : "s"} can be run now by anyone; you pay the network fees and any payout account rent (about 0.002 SOL each), and every payout goes to its owner.`,
    ownerWindow: (slot: string) =>
      `Traders have until slot ${slot} to close their own positions. After that anyone can finish the market. Empty positions can be cleaned up now.`,
    escrowed: (n: number) => `${n} position${n === 1 ? " is" : "s are"} wrapped as an NFT and can only be closed by the holder.`,
    locked: (n: number) => `${n} position${n === 1 ? " is" : "s are"} mid-liquidation or mid-rebalance and cannot be closed yet.`,
    button: "Finish the market",
    running: "Finishing…",
    result: (sent: number, refused: number) =>
      `Sent ${sent} transaction${sent === 1 ? "" : "s"}.${refused > 0 ? ` ${refused} step${refused === 1 ? " was" : "s were"} refused by the program and left as is.` : ""}`,
  } as const,
  /** Creator panel notice when the junior is exhausted (senior-impaired flag set on chain). */
  juniorExhausted:
    "Your junior tranche is exhausted: further losses now hit Earn depositors pro rata. Winning trades are still paid in full. New Earn deposits are paused.",
  /** Earn risk notice on P3 markets: who bears a loss (user decision 2026-09-30, reversed; final wording from P3 doc §0.8). */
  earnRiskP3:
    "Earn deposits back each market's vault-owned LP and can lose value. Losses hit the creator's junior first, then Earn depositors pro rata. Winning trades are always paid in full. Only deposit what you can afford to lose.",
  p3Wizard: {
    title: "Vault-owned LP (junior tranche)",
    explain:
      "Your market's liquidity is provided by an LP the Earn vault owns. You fund its first-loss (junior) tranche, and trading PnL against it is yours. Losses hit the creator's junior first, then Earn depositors pro rata. Winning trades are always paid in full.",
    floorLabel: "Junior floor",
    floorTooltip:
      "The share of Earn deposits your tranche must cover. You cannot withdraw below it while Earn depositors are in the vault. 10% to 100%.",
    amountLabel: "Junior deposit",
    minHint: (min: string, sym: string) => `At least ${min} ${sym} (the floor of the Earn seed).`,
    marketauthRotated:
      "The market's admin authority has already moved to its staking pool, so the vault-owned LP can no longer be bound on this market (binding needs the market admin's signature). The market keeps its classic LP.",
    pinned:
      "The protocol sets this LP's matcher and its limits at launch (a vAMM with a $5,000 per-trade and $25,000 net-exposure cap at the launch price); you choose only the junior tranche and its floor. Trading opens as soon as the market is created.",
    issue: {
      "floor-out-of-range": "The junior floor must be between 10% and 100%.",
      "junior-zero": "Enter a junior tranche deposit greater than zero.",
      "junior-below-floor": "The junior deposit must at least cover the junior floor of the Earn seed.",
      "junior-above-liquidity": "The junior deposit cannot exceed the market's liquidity amount.",
    },
  } as const,
  earnPlanBlocked: {
    "registry-invalid": "This Earn vault's on-chain registry has an invalid vault-LP flag, so the program refuses every Earn action. Contact the market operator.",
    "vault-lp-unreadable": "This Earn vault is backed by a vault-owned LP whose state could not be read. Retry in a moment.",
  } as const,
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
  // 77. Next P3 FINAL: also returned by TradeNoCpi / BatchTradeNoCpi that grow either side on a
  // P3 asset (the app never sends those; __tests__/lib/limits/no-nocpi-on-p3.test.ts).
  VaultLpExclusiveCounterparty:
    "On this market every trade that adds risk goes through the market's matcher against the Earn vault's LP. Direct account-to-account trades and trades against any other LP are refused. Reducing or closing a position still works.",
  VaultLpLeverageStepDown:
    "Leverage too high for this side while the book is crowded. Lower leverage or trade the other side.",
  VaultLpBoundCannotClose: "This vault owns the market's LP and can't be closed.",
  VaultLpExposureCapExceeded:
    "This trade is larger than the Earn vault's LP can take: its exposure is capped at a multiple of the creator's first-loss capital. Reduce the size.",
  VaultLpMatcherNotApproved: "The protocol has not approved this pricing engine for the market's vault LP.",
  VaultLpUseSettleResolved: "This market is resolved: the vault's LP is settled through the vault (senior first), not closed directly.",
  VaultLpReleaseRefused: "Nothing to release: the vault's backing does not exceed what Earn depositors are owed.",
  VaultLpHarvestPending:
    "This vault has LP fees waiting to be credited. They must be cranked before the first Earn deposit, so the first depositor can't buy them at 1:1. Try again shortly.",
  VaultLpValuationStale:
    "The vault's LP has open positions and needs a refresh before the vault can be priced. Try again: the refresh is permissionless and usually lands within seconds.",
  VaultLpMultiAssetMarket:
    "An Earn vault can only own the LP of a single-asset market, and this market has more than one asset slot, so the vault can't take its LP. Create a new market to get a vault-owned LP.",
};

/** P3 copy re-keyed by the CURRENT provisional ordinals. */
export function p3ErrorCopyByCode(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [name, code] of Object.entries(P3_ERR) as [keyof typeof P3_ERR, number][]) {
    out[code] = P3_ERROR_COPY_BY_NAME[name];
  }
  return out;
}
