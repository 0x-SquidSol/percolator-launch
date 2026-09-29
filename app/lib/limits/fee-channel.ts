/**
 * P2 fee channel (P1 e74809b1 + P2 4a0f696): when the protocol enables it for an
 * asset (`AssetRiskLimitsV17.max_requested_fee_bps > 0` with `matcher_ext_mode == 1`),
 * TradeCpi CHARGES the matcher's quote as a fee on mark-settled notional and credits it
 * to the LP. It is charged only if the TAKER-SIGNED `fee_bps` covers base + requested
 * (`requested_fee_permitted`), otherwise the trade is refused InvalidInstruction(9).
 *
 * So on such a market the ticket must sign base + the quote's requested fee — that
 * signature IS the taker's consent (security review P2-4 (a)), and the quote panel
 * must say the price is charged (P2-4 (c)). Channel off => sign the base fee as today.
 */
import { BPS, MAX_REQUESTED_FEE_BPS, MATCHER_EXT_MODE_V1 } from "./constants";

/** P2 `v2::requested_fee_bps`: ceil(|exec − oracle|·1e4 / oracle), capped at 1023; 0 oracle => 0. */
export function requestedFeeBps(oracleE6: bigint, execE6: bigint): bigint {
  if (oracleE6 === 0n) return 0n;
  const d = execE6 > oracleE6 ? execE6 - oracleE6 : oracleE6 - execE6;
  const num = d * BPS;
  const bps = num / oracleE6 + (num % oracleE6 === 0n ? 0n : 1n);
  const cap = BigInt(MAX_REQUESTED_FEE_BPS);
  return bps < cap ? bps : cap;
}

/** P1 `requested_fee_permitted`. */
export function requestedFeePermitted(
  requestedBps: bigint,
  baseFeeBps: bigint,
  takerSignedFeeBps: bigint,
  protocolMaxBps: number,
  maxTradingFeeBps: bigint,
): boolean {
  if (requestedBps === 0n) return true;
  const total = baseFeeBps + requestedBps;
  if (total > 0xffff_ffff_ffff_ffffn) return false;
  return protocolMaxBps !== 0 && requestedBps <= BigInt(protocolMaxBps) && total <= takerSignedFeeBps && total <= maxTradingFeeBps;
}

export interface FeeChannel {
  enabled: boolean;
  protocolMaxBps: number;
}

export function feeChannelOf(limits: { matcherExtMode: number; maxRequestedFeeBps: number } | null): FeeChannel {
  if (!limits) return { enabled: false, protocolMaxBps: 0 };
  const enabled = limits.matcherExtMode === MATCHER_EXT_MODE_V1 && limits.maxRequestedFeeBps > 0;
  return { enabled, protocolMaxBps: enabled ? limits.maxRequestedFeeBps : 0 };
}

export type SignedFeeVerdict = "ok" | "over-protocol-max" | "over-market-max";

/**
 * The fee_bps the ticket signs for a quote: base + requested(quote) when the channel is
 * on, else base. `verdict` says whether the program would accept it at that quote.
 */
export function signedFeeForQuote(
  baseFeeBps: bigint,
  quoteExecE6: bigint | null,
  oracleE6: bigint,
  channel: FeeChannel,
  maxTradingFeeBps: bigint,
  legacyBoundBps?: number,
): { signedFeeBps: bigint; requestedBps: bigint; verdict: SignedFeeVerdict } {
  if (!channel.enabled) return { signedFeeBps: baseFeeBps, requestedBps: 0n, verdict: "ok" };
  // Kind 0/1 matchers have no exact client quote: consent to their price bound
  // (max_total, already clamped to the band), capped at the protocol maximum.
  if (quoteExecE6 === null) {
    if (legacyBoundBps === undefined) return { signedFeeBps: baseFeeBps, requestedBps: 0n, verdict: "ok" };
    const b = BigInt(Math.min(legacyBoundBps, channel.protocolMaxBps));
    const signed = baseFeeBps + b;
    return { signedFeeBps: signed, requestedBps: b, verdict: signed > maxTradingFeeBps ? "over-market-max" : "ok" };
  }
  const req = requestedFeeBps(oracleE6, quoteExecE6);
  const signed = baseFeeBps + req;
  let verdict: SignedFeeVerdict = "ok";
  if (req > BigInt(channel.protocolMaxBps)) verdict = "over-protocol-max";
  else if (signed > maxTradingFeeBps) verdict = "over-market-max";
  return { signedFeeBps: signed, requestedBps: req, verdict };
}

/**
 * The fee_bps `useTrade` signs: the ticket's fee-channel consent when given, else the
 * market's configured base trade fee (30 bps if the config is not loaded — the legacy
 * fallback). Never 0 by default: fee_bps 0 is REFUSED by the v18 wrapper.
 */
export function tradeFeeBpsToSign(override: bigint | undefined, marketBaseFeeBps: bigint | undefined): bigint {
  return override ?? marketBaseFeeBps ?? 30n;
}
