import { PublicKey } from '@solana/web3.js';
import {
  CTX_VAMM_OFFSET,
  MATCHER_CONTEXT_LEN,
  V17_PORTFOLIO_IDENTITY_TRAILER_LEN,
  decodePortfolioMatcherControl,
} from '@percolatorct/sdk';

const PUBLIC_KEY_LEN = 32;

/**
 * PortfolioMatcherConfigV16 sits near the end of each v17/v18 portfolio account:
 *
 * matcher_program[32]
 * matcher_context[32]
 * matcher_delegate[32]
 * control[u64]           (v18: packed — bit 0 = enabled, plus epoch/fee-cap)
 *
 * In v18 a `V17_PORTFOLIO_IDENTITY_TRAILER_LEN`-byte identity trailer follows
 * this config, so it is NO LONGER the final 104 bytes — the offset below
 * subtracts the trailer, and the enabled bit is decoded via the SDK.
 */
export const V17_PORTFOLIO_MATCHER_CONFIG_LEN = 104;

const MATCHER_PROGRAM_RELATIVE_OFFSET = 0;
const MATCHER_CONTEXT_RELATIVE_OFFSET = 32;
const MATCHER_DELEGATE_RELATIVE_OFFSET = 64;
const MATCHER_ENABLED_RELATIVE_OFFSET = 96;

export interface V17PortfolioMatcherConfig {
  matcherProgram: PublicKey;
  matcherContext: PublicKey;
  matcherDelegate: PublicKey;
  enabled: boolean;
}

export type V17MatcherContextState = 'initialized' | 'uninitialized' | 'invalid';

/**
 * Reads PortfolioMatcherConfigV16 from the trailing 104 bytes of a
 * v17 portfolio account.
 *
 * Disabled configurations are returned with enabled=false so callers
 * can distinguish a recoverable incomplete setup from malformed data.
 */
export function readV17PortfolioMatcherConfig(data: Uint8Array): V17PortfolioMatcherConfig {
  const trailerLen = V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
  if (data.byteLength < V17_PORTFOLIO_MATCHER_CONFIG_LEN + trailerLen) {
    throw new Error(
      `Invalid v17 portfolio length: expected at least ` +
        `${V17_PORTFOLIO_MATCHER_CONFIG_LEN + trailerLen} bytes, received ` +
        `${data.byteLength}`,
    );
  }

  // v18: the config is followed by the identity trailer, so anchor off the end
  // minus BOTH the trailer and the config length.
  const offset = data.byteLength - V17_PORTFOLIO_MATCHER_CONFIG_LEN - trailerLen;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // v18: the trailing u64 is a packed control word (bit 0 = enabled). Decode via
  // the SDK rather than comparing to 0/1 — the upper bits carry epoch/fee-cap.
  const control = view.getBigUint64(offset + MATCHER_ENABLED_RELATIVE_OFFSET, true);
  const enabled = decodePortfolioMatcherControl(control).enabled;

  return {
    matcherProgram: new PublicKey(
      data.subarray(
        offset + MATCHER_PROGRAM_RELATIVE_OFFSET,
        offset + MATCHER_PROGRAM_RELATIVE_OFFSET + PUBLIC_KEY_LEN,
      ),
    ),
    matcherContext: new PublicKey(
      data.subarray(
        offset + MATCHER_CONTEXT_RELATIVE_OFFSET,
        offset + MATCHER_CONTEXT_RELATIVE_OFFSET + PUBLIC_KEY_LEN,
      ),
    ),
    matcherDelegate: new PublicKey(
      data.subarray(
        offset + MATCHER_DELEGATE_RELATIVE_OFFSET,
        offset + MATCHER_DELEGATE_RELATIVE_OFFSET + PUBLIC_KEY_LEN,
      ),
    ),
    enabled,
  };
}

function isAllZero(data: Uint8Array): boolean {
  return data.every((value) => value === 0);
}

export function isEmptyV17PortfolioMatcherConfig(config: V17PortfolioMatcherConfig): boolean {
  return (
    !config.enabled &&
    config.matcherProgram.equals(PublicKey.default) &&
    config.matcherContext.equals(PublicKey.default) &&
    config.matcherDelegate.equals(PublicKey.default)
  );
}

/**
 * Classifies a matcher-context account using the matcher program's
 * authoritative context layout.
 *
 * The matcher writes its expected LP signer 16 bytes after CTX_VAMM_OFFSET (the
 * one-time initialization. In the wrapper flow that signer is the
 * derived matcher-delegate PDA.
 *
 * Account ownership must be checked separately by the caller because
 * ownership is part of AccountInfo rather than account data.
 */
export function inspectV17MatcherContext(
  data: Uint8Array,
  expectedDelegate: PublicKey,
): V17MatcherContextState {
  if (data.byteLength < MATCHER_CONTEXT_LEN) {
    return 'invalid';
  }

  // The 16-byte VAMM magic sits at CTX_VAMM_OFFSET; the matcher's expected
  // LP-signer delegate is the 32-byte pubkey that immediately FOLLOWS it. Reading
  // the delegate at CTX_VAMM_OFFSET itself hits the magic bytes and mis-classifies
  // every genuinely-initialized context as 'invalid' — verified against live
  // devnet matcher contexts (delegate at CTX_VAMM_OFFSET+16, magic at +0).
  const delegateStart = CTX_VAMM_OFFSET + 16;
  const delegateEnd = delegateStart + PUBLIC_KEY_LEN;

  if (delegateEnd > data.byteLength) {
    return 'invalid';
  }

  const storedDelegate = data.subarray(delegateStart, delegateEnd);

  if (isAllZero(storedDelegate)) {
    return 'uninitialized';
  }

  return new PublicKey(storedDelegate).equals(expectedDelegate) ? 'initialized' : 'invalid';
}
