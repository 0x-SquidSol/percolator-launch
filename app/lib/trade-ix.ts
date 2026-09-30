/**
 * The v18 TradeCpi / BatchTradeCpi instruction, extracted from hooks/useTrade.ts so the
 * first-trade flow (UX WP-6: [Deposit, Trade] against a portfolio that does not exist yet when
 * the tx is signed) builds the byte-identical instruction with a PREDICTED taker identity.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { encodeTradeCpi, encodeBatchTradeCpi, ACCOUNTS_TRADE_CPI, buildAccountMetas, buildIx } from "@percolatorct/sdk";
import { tradeFeeBpsToSign } from "@/lib/limits/fee-channel";

export interface TradeIdentity {
  portfolioId: bigint;
  positionEpoch: bigint;
}

export interface TradeCpiIxParams {
  programId: PublicKey;
  signer: PublicKey;
  market: PublicKey;
  accountA: PublicKey;
  accountB: PublicKey;
  matcherProg: PublicKey;
  matcherCtx: PublicKey;
  matcherDelegate: PublicKey;
  takerId: TradeIdentity;
  lpId: TradeIdentity & { matcherSequence: bigint };
  marketId: bigint;
  /** Legs (sum = size); one leg => TradeCpi, more => BatchTradeCpi. */
  legs: bigint[];
  size: bigint;
  limitPriceE6: bigint;
  /** The P2 signed fee cap, when the channel is on. */
  feeBps?: bigint;
  /** The market's configured trade fee (wrapperConfigV17.tradeFeeBps). */
  marketTradeFeeBps?: bigint;
}

/**
 * v18: TradeCpi/BatchTradeCpi bind the two portfolios' identity (portfolioId + positionEpoch)
 * + accountB's matcher-sequence + the asset marketId. feeBps MUST be the market's configured
 * trade fee (fee_bps=0 with a non-zero insurance share fails validation, Custom 9).
 */
export function buildTradeCpiIx(p: TradeCpiIxParams): TransactionInstruction {
  const fee = tradeFeeBpsToSign(p.feeBps, p.marketTradeFeeBps);
  return buildIx({
    programId: p.programId,
    keys: buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      p.signer, // [0] signerA
      p.market, // [1] market
      p.accountA, // [2] accountA (taker portfolio)
      p.accountB, // [3] accountB (LP portfolio)
      p.matcherProg, // [4] matcherProg
      p.matcherCtx, // [5] matcherCtx
      p.matcherDelegate, // [6] matcherDelegate
    ]),
    data:
      p.legs.length > 1
        ? encodeBatchTradeCpi({
            legs: p.legs.map((legSize) => ({
              assetIndex: 0,
              marketId: p.marketId,
              sizeQ: legSize.toString(),
              feeBps: fee,
              limitPrice: p.limitPriceE6.toString(),
            })),
            maxSlippageAtoms: 0n,
            maxFeeAtoms: 0n,
            accountAPortfolioId: p.takerId.portfolioId,
            accountAPositionEpoch: p.takerId.positionEpoch,
            accountBPortfolioId: p.lpId.portfolioId,
            accountBPositionEpoch: p.lpId.positionEpoch,
            accountBMatcherSequence: p.lpId.matcherSequence,
          })
        : encodeTradeCpi({
            accountAPortfolioId: p.takerId.portfolioId,
            accountAPositionEpoch: p.takerId.positionEpoch,
            accountBPortfolioId: p.lpId.portfolioId,
            accountBPositionEpoch: p.lpId.positionEpoch,
            accountBMatcherSequence: p.lpId.matcherSequence,
            assetIndex: 0,
            marketId: p.marketId,
            sizeQ: p.size.toString(),
            feeBps: fee,
            limitPrice: p.limitPriceE6.toString(),
            backingFeeCapBps: 0,
          }),
  });
}
