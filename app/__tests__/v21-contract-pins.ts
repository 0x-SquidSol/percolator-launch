/**
 * QUARANTINE. Read this before adding to it.
 *
 * With the v2.2 flag ON (NEXT_PUBLIC_DEVNET_V22=1) the tests below cannot hold, because they describe the v2.1 world. Instead of failing
 * they are QUARANTINED: setup.ts reruns exactly these entries with the v2.2 and v2.1 flags pinned OFF. They are NOT v2.2 coverage. Every
 * entry is a debt: "needs a v2.2 fixture rewrite" (reason per entry below). Remove an entry when its test is rewritten.
 * Any flag-on failure NOT on these lists is a real regression and fails the run. The count is printed at the start of every flag-on run
 * (global-setup.ts), so the quarantine is never silently green. Flag OFF this file is inert.
 *
 * LOT0 (converted, NOT quarantined): tests that only failed because no lot exponent was known (N1 gate). They run FLAG ON with exponent 0
 * seeded through __setUnknownLotExpForTest. Audit 2026-10-17 T4: ledger v22-full-audit-2026-10-17/T4-app-tests.md.
 */
export type QuarantineReason = string;

/** Whole files (import-time failures, or files that vi.resetModules() so a per-test pin does not reach them). [file, reason] */
export const QUARANTINED_FILES: ReadonlyArray<readonly [file: string, reason: QuarantineReason]> = [
];

/** Single tests. [file, vitest full name (suite names and test name joined by one space), reason] */
export const QUARANTINED_TESTS: ReadonlyArray<readonly [file: string, fullName: string, reason: QuarantineReason]> = [
  ["__tests__/hooks/useEarnStats-split-pot-tvl.test.ts", "fetchCuratedVaultsOnChain: two-pot vaults are valued at NAV uses the combined NAV, from one batched read of market + both ledgers", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
  ["__tests__/hooks/useEarnStats-split-pot-tvl.test.ts", "fetchCuratedVaultsOnChain: two-pot vaults are valued at NAV keeps shares + fees for a bound vault, with no extra read", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
  ["__tests__/hooks/useEarnStats-split-pot-tvl.test.ts", "fetchCuratedVaultsOnChain: two-pot vaults are valued at NAV no shares outstanding: the vault adds 0, not its lifetime fees (and isn't flagged unvalued)", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
  ["__tests__/hooks/useEarnStats-split-pot-tvl.test.ts", "fetchCuratedVaultsOnChain: two-pot vaults are valued at NAV a failed two-pot read fails the cycle (keep-last-good), not a silent shares + fees", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
  ["__tests__/hooks/useEarnStats-split-pot-tvl.test.ts", "fetchCuratedVaultsOnChain: two-pot vaults are valued at NAV the wrapper version can't be read and the floor changes this vault's value: fails the cycle", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
  ["__tests__/hooks/useEarnStats-split-pot-tvl.test.ts", "fetchCuratedVaultsOnChain: two-pot vaults are valued at NAV the wrapper version can't be read but the floor doesn't matter for this vault: priced as usual", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
  ["__tests__/hooks/useEarnStats-split-pot-tvl.test.ts", "fetchCuratedVaultsOnChain: two-pot vaults are valued at NAV passes the NAV floor on (post-upgrade wrapper) and off (pre-upgrade)", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
  ["__tests__/hooks/useFirstTrade.fill-result.test.ts", "useFirstTrade records the MEASURED fill for the ticket first trade (new account): a 0.8225 SOL order that landed as 72 q is a PARTIAL fill of 72", "v2.1 fixture: VERSION-18 / zero / 3,675 B market or portfolio bytes, refused by the VERSION-keyed v2.2 layout. Needs a v2.2 (VERSION 19) fixture rewrite."],
  ["__tests__/hooks/useFirstTrade.fill-result.test.ts", "useFirstTrade records the MEASURED fill for the ticket returning user ([deposit, trade]): the delta is measured from the position held before", "v2.1 fixture: VERSION-18 / zero / 3,675 B market or portfolio bytes, refused by the VERSION-keyed v2.2 layout. Needs a v2.2 (VERSION 19) fixture rewrite."],
  ["__tests__/hooks/useFirstTrade.fill-result.test.ts", "useFirstTrade records the MEASURED fill for the ticket a full fill is still reported as full", "v2.1 fixture: VERSION-18 / zero / 3,675 B market or portfolio bytes, refused by the VERSION-keyed v2.2 layout. Needs a v2.2 (VERSION 19) fixture rewrite."],
  ["__tests__/hooks/useInsuranceLP.test.ts", "useInsuranceLP Deposit (v17 LP Vault — DepositToLpVault tag 75) routes the deposit to the registry's own domain, not a hardcoded 0", "v2.1 fixture: VERSION-18 / zero / 3,675 B market or portfolio bytes, refused by the VERSION-keyed v2.2 layout. Needs a v2.2 (VERSION 19) fixture rewrite."],
  ["__tests__/hooks/useInsuranceLP.test.ts", "useInsuranceLP Withdraw (v17 LP Vault — RequestRedeemLpShares tag 76 / ExecuteRedemption tag 77) should call ExecuteRedemption when redemption account already exists", "v2.1 fixture: VERSION-18 / zero / 3,675 B market or portfolio bytes, refused by the VERSION-keyed v2.2 layout. Needs a v2.2 (VERSION 19) fixture rewrite."],
  ["__tests__/hooks/useInsuranceLP.test.ts", "useInsuranceLP Withdraw (v17 LP Vault — RequestRedeemLpShares tag 76 / ExecuteRedemption tag 77) ExecuteRedemption passes all 13 accounts, [12] = the redeemer as writable, signing rent destination", "v2.1 fixture: VERSION-18 / zero / 3,675 B market or portfolio bytes, refused by the VERSION-keyed v2.2 layout. Needs a v2.2 (VERSION 19) fixture rewrite."],
  ["__tests__/hooks/useInsuranceLP.test.ts", "useInsuranceLP Withdraw (v17 LP Vault — RequestRedeemLpShares tag 76 / ExecuteRedemption tag 77) registry cooldown 150n slots -> requested, 1 instruction(s) in ONE signature", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
  ["__tests__/hooks/useInsuranceLP.test.ts", "useInsuranceLP Withdraw (v17 LP Vault — RequestRedeemLpShares tag 76 / ExecuteRedemption tag 77) registry cooldown 0n slots -> executed, 2 instruction(s) in ONE signature", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
  ["__tests__/hooks/useInsuranceLP.test.ts", "useInsuranceLP vault read failures a failed registry read keeps the last good vault and flags readError", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
  ["__tests__/hooks/useInsuranceLP.test.ts", "useInsuranceLP vault read failures a failed redemption-ticket read keeps the last good state and flags readError", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
  ["__tests__/hooks/useInsuranceLP.test.ts", "useInsuranceLP vault read failures the next good read clears readError", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
  ["__tests__/hooks/useInsuranceLP.test.ts", "useInsuranceLP vault read failures stays loading while the slab is still loading, then loads", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
  ["__tests__/hooks/useInsuranceLP.test.ts", "useInsuranceLP position with a pending withdrawal share % and value count the escrowed shares, not only the wallet's", "v2.1 mock seam: mocks the v2.1 SDK parser (or passes zero bytes) while v2.2 reads through lib/v22/layout. Needs a v2.2 fixture / mock rewrite."],
];

/** Converted: run flag ON with lot exponent 0 for unobserved slabs. [file, vitest full name] */
export const LOT0_TESTS: ReadonlyArray<readonly [file: string, fullName: string]> = [
  ["__tests__/components/MarketCard.test.tsx", "MarketBrowser Component Tests Edge Cases and Error Handling should display market stats correctly"],
  ["__tests__/components/portfolio-at-risk-live.test.tsx", "/portfolio at-risk strip follows the live mark strip, card and count agree at the live price"],
  ["__tests__/components/portfolio-at-risk-live.test.tsx", "/portfolio at-risk strip follows the live mark the count goes 0 -> 1 when a tick moves a safe position into range"],
  ["__tests__/components/portfolio-at-risk-live.test.tsx", "/portfolio at-risk strip follows the live mark short: distance is measured up to the liquidation price"],
  ["__tests__/components/portfolio-at-risk-live.test.tsx", "/portfolio at-risk strip follows the live mark clears when the price recovers, though the poll still says at risk"],
  ["__tests__/components/portfolio-size-usd.test.tsx", "/portfolio card size in USD follows the live mark; a short's value is its magnitude"],
  ["__tests__/components/position-pnl-surfaces.test.tsx", "ClosePositionModal when the ADL state is unknown (item 3) known ADL: the modal gets the EFFECTIVE size and a live preview"],
  ["__tests__/components/position-pnl-surfaces.test.tsx", "ClosePositionModal when the ADL state is unknown (item 3) unknown ADL: the preview is withheld"],
  ["__tests__/hooks/useClosePosition-not-loaded.test.ts", "close before this market's position has loaded a retry after the account lands clears the message; a double click stays silent"],
  ["__tests__/hooks/useClosePosition.adl-route.test.ts", "useClosePosition — F-3 reduce-only routing (real ANSEM bytes) reduce-only market => tag 44 with the fresh position; the matcher is never called"],
  ["__tests__/hooks/useClosePosition.adl-route.test.ts", "useClosePosition — F-3 reduce-only routing (real ANSEM bytes) stale poll (healthy) but the chain is reduce-only: the close's FRESH market read routes to tag 44 directly"],
  ["__tests__/hooks/useClosePosition.adl-route.test.ts", "useClosePosition — F-3 reduce-only routing (real ANSEM bytes) tag 44 partial (capacity-limited) => resolves with the partial reason"],
  ["__tests__/hooks/useClosePosition.effective-qty.test.ts", "useClosePosition — ADL-effective close size (M-3) after an ADL, Close 100% reduces the EFFECTIVE quantity (tag 44), fill checked against basis"],
  ["__tests__/hooks/useClosePosition.effective-qty.test.ts", "useClosePosition — ADL-effective close size (M-3) Close 50% after an ADL is half of the EFFECTIVE position, not half of basis"],
  ["__tests__/hooks/useClosePosition.effective-qty.test.ts", "useClosePosition — ADL-effective close size (M-3) negative control (healthy market): effective == basis, matcher close of exactly -basis"],
  ["__tests__/hooks/useClosePosition.effective-qty.test.ts", "useClosePosition — ADL-effective close size (M-3) a prior-reset leg (ResetPending, epoch moved on by 1) sends nothing and says so"],
  ["__tests__/hooks/useClosePosition.effective-qty.test.ts", "useClosePosition — ADL-effective close size (M-3) an epoch the engine would refuse (not a prior reset) blocks the close"],
  ["__tests__/hooks/useClosePosition.effective-qty.test.ts", "useClosePosition — ADL-effective close size (M-3) M-2: a position of 4x the per-fill cap goes to trade() as 4 legs summing to -basis"],
  ["__tests__/hooks/useClosePosition.explicit-target.test.ts", "useClosePosition { portfolioPk } (#3301) a flat target is an error the user sees; nothing is sent and the other account is untouched"],
  ["__tests__/hooks/useClosePosition.explicit-target.test.ts", "useClosePosition { portfolioPk } (#3301) a target owned by another wallet is refused"],
  ["__tests__/hooks/useClosePosition.explicit-target.test.ts", "useClosePosition { portfolioPk } (#3301) a target on a different market is refused"],
  ["__tests__/hooks/useClosePosition.explicit-target.test.ts", "useClosePosition { portfolioPk } (#3301) a target not owned by the market program is refused"],
  ["__tests__/hooks/useClosePosition.explicit-target.test.ts", "useClosePosition { portfolioPk } (#3301) a target that does not exist is refused, with no fallback scan"],
  ["__tests__/hooks/useClosePosition.explicit-target.test.ts", "useClosePosition { portfolioPk } (#3301) a reused read of one account never serves another (cache is per target)"],
  ["__tests__/hooks/useClosePosition.explicit-target.test.ts", "useClosePosition { portfolioPk } (#3301) no row (no target): the old resolution is kept, and a flat result is now an error instead of a silent success"],
  ["__tests__/hooks/useClosePosition.explicit-target.test.ts", "useClosePosition { portfolioPk } (#3301) no row (no target): with a position it still closes the wallet's default account"],
  ["__tests__/hooks/useClosePosition.fresh-state.test.ts", "useClosePosition fresh-state verification control: uses the fresh v12 position when verification succeeds"],
  ["__tests__/hooks/useClosePosition.fresh-state.test.ts", "useClosePosition fresh-state verification blocks close when the v12 fresh-position read fails"],
  ["__tests__/hooks/useClosePosition.fresh-state.test.ts", "useClosePosition fresh-state verification notifies the portfolio bus after a successful close (site-wide PositionsBar)"],
  ["__tests__/hooks/useClosePosition.zero-fill.test.ts", "useClosePosition — measured fill zero fill: throws, error = 'Market at capacity — no fill', phase never 'confirming'"],
  ["__tests__/hooks/useClosePosition.zero-fill.test.ts", "useClosePosition — measured fill full fill: resolves with the signature and the measured fill"],
  ["__tests__/hooks/useClosePosition.zero-fill.test.ts", "useClosePosition — measured fill partial fill: resolves, but says only part closed"],
  ["__tests__/hooks/useClosePosition.zero-fill.test.ts", "useClosePosition — measured fill not measured (P1 flag off): legacy success path"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Happy Path should execute trade successfully as a lone TradeCpi (no crank in the trade's tx)"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Happy Path lets the oracle-authority wallet trade on an admin market (no inline push)"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Error Handling legacy v12 slab (no v17 header): should throw error if LP not found"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Error Handling should handle RPC errors gracefully"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Oracle Mode Detection should detect admin oracle when authority is set but another publisher is responsible"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Oracle Mode Detection should detect admin oracle when feed is all zeros"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Oracle Mode Detection should use Pyth oracle for standard markets"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Loading State should set loading state during trade execution"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Slippage protection auto-computes a non-zero limit for a long when the caller omits limitPriceE6"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Slippage protection auto-computes a non-zero limit ≤ mark for a short (size < 0)"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Slippage protection preserves an explicit limitPriceE6 supplied by the caller"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Slippage protection keeper escape hatch: explicit limitPriceE6 = 0n is passed through unchanged"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Slippage protection aborts the trade if the live mark price is null (no oracle yet)"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Slippage protection aborts the trade if the live mark price is 0n (broken oracle)"],
  ["__tests__/hooks/useTrade.test.ts", "useTrade Slippage protection never encodes the on-chain 0-sentinel by default"],
  ["__tests__/lib/priceStore-poll.test.ts", "applyOnChainPoll seeds an empty slab"],
  ["__tests__/lib/priceStore-poll.test.ts", "applyOnChainPoll overwrites a DB seed (poll data is fresher than a cold-start seed)"],
  ["__tests__/lib/priceStore-poll.test.ts", "applyOnChainPoll NEVER overwrites a recent live WS tick"],
  ["__tests__/lib/priceStore-poll.test.ts", "applyOnChainPoll updates again once the live feed has been silent past the staleness window"],
  ["__tests__/components/layout/LiquidationAlert.test.tsx", "LiquidationAlert Hide keeps it hidden at the same tier, and it comes back when it gets worse"],
  ["__tests__/components/layout/LiquidationAlert.test.tsx", "LiquidationAlert a hidden position alerts again after leaving the range and coming back"],
  ["__tests__/components/layout/LiquidationAlert.test.tsx", "LiquidationAlert the close window stays open when the position moves out of range"],
  ["__tests__/components/market/LiveRowPrice.test.tsx", "LiveRowPrice flashes green on an up-tick and red on a down-tick, then rests"],
  ["__tests__/components/trade/PositionsDock.close-binding.test.tsx", "PositionsDock Close binds the row's own account (#3301) opening the modal prewarms, and confirming closes, exactly the account the row shows"],
  ["__tests__/components/trade/PositionsDock.close-error.test.tsx", "PositionsDock close modal error shows a failed close's error inside the still-open modal"],
  ["__tests__/components/trade/PositionsDock.close-error.test.tsx", "PositionsDock close modal error does not carry the previous attempt's error into a reopened modal"],
  ["__tests__/components/trade/close-entry-points-oracle-gate.test.tsx", "Close Confirm (dock) stale 5 minutes on an AUTH_MARK market: Confirm enabled, one calm note"],
  ["__tests__/components/trade/close-entry-points-oracle-gate.test.tsx", "Close Confirm (dock) matured: Confirm blocked"],
  ["__tests__/components/trade/close-entry-points-oracle-gate.test.tsx", "Close Confirm (dock) price unavailable: Confirm blocked"],
  ["__tests__/components/trade/close-entry-points-oracle-gate.test.tsx", "Close Confirm (dock) fresh: Confirm enabled, no note"],
];
