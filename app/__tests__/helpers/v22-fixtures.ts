import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { LAYOUT_V22 } from "@/lib/v22/sdk/layout";

/**
 * v2.2 (wrapper VERSION 19) account fixtures for tests that used to run on v2.1 (VERSION 18) bytes.
 *
 * Bytes are CAPTURED from the deployed v2.2 devnet program, never hand-built from the app's own decoders:
 *  - market: the one-slot SOL market (4,059 B), fixtures/v22-market-single-asset-SOL.json
 *  - portfolio: a flat 10,603 B trader portfolio, fixtures/v22-flat-winner-portfolio-2026-10-11.json
 * Patches are written at offsets from the SDK table LAYOUT_V22 (pinned to rustc `offset_of!` by lib/v22/rust-layout-parity-d1.test.ts).
 */
const FX = join(__dirname, "..", "fixtures");
const MARKET_FX = JSON.parse(readFileSync(join(FX, "v22-market-single-asset-SOL.json"), "utf8")) as { market: string; owner: string; dataBase64: string };
const PORTFOLIO_FX = JSON.parse(readFileSync(join(FX, "v22-flat-winner-portfolio-2026-10-11.json"), "utf8")) as { market: string; owner: string; b64: string };

/** The v2.2 fresh-ID wrapper program. */
export const V22_PROGRAM = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
/** Address the captured one-slot market lived at. */
export const V22_SLAB = new PublicKey(MARKET_FX.market);
/** The captured portfolio's owner. */
export const V22_OWNER = new PublicKey(PORTFOLIO_FX.owner);

/** A fresh copy of the captured one-slot v2.2 market account (4,059 B, VERSION 19). */
export const v22MarketBytes = (): Uint8Array => new Uint8Array(Buffer.from(MARKET_FX.dataBase64, "base64"));
/** A fresh copy of the captured flat v2.2 portfolio (10,603 B, VERSION 19). */
export const v22PortfolioBase = (): Buffer => Buffer.from(PORTFOLIO_FX.b64, "base64");

const LEG = LAYOUT_V22.portfolio.leg;
const LEG0 = LAYOUT_V22.portfolio.legsOff;
export const V22_LEG_ACTIVE = LEG0 + LEG.active;
export const V22_LEG_SIDE = LEG0 + LEG.side;
export const V22_LEG_BASIS = LEG0 + LEG.basisPosQ;

/** The captured portfolio with its first leg patched (and, optionally, re-owned / re-homed). */
export function v22Portfolio(o: { side: 0 | 1; basis: bigint; active?: boolean; owner?: PublicKey; market?: PublicKey }): Buffer {
  const d = v22PortfolioBase();
  (o.market ?? V22_SLAB).toBuffer().copy(d, 16);
  if (o.owner) o.owner.toBuffer().copy(d, 116);
  d[V22_LEG_ACTIVE] = o.active === false ? 0 : 1;
  d[V22_LEG_SIDE] = o.side;
  d.writeBigUInt64LE(o.basis, V22_LEG_BASIS);
  return d;
}

/**
 * A v2.2 portfolio whose PortfolioMatcherConfigV16 control word has `enabled` set (an LP) or clear (a trader). The control word is the last
 * u64 of the 104 B config: matcher_program[32] | matcher_context[32] | matcher_delegate[32] | control[8] (bit 0 = enabled).
 */
export function v22MatcherPortfolio(enabled: boolean, base: Buffer = v22PortfolioBase()): Buffer {
  const d = Buffer.from(base);
  d.writeBigUInt64LE(enabled ? 1n : 0n, LAYOUT_V22.portfolio.matcherConfigOff + 96);
  return d;
}
