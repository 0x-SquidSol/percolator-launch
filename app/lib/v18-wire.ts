/**
 * v18 write-wire anti-replay field sourcing.
 *
 * The v18 wrapper (integration `a9318945`, VERSION 18) binds every state-changing
 * instruction to live on-chain CAS/replay counters. Wrong values are REJECTED
 * on-chain, so these MUST be read live before building each instruction — never
 * hardcoded.
 *
 * Field → source (ported VERBATIM from the gate-validated seed client
 * ~/percolator-v17-devnet-test/playground/newmarkets.ts and percolator-gate
 * branch migration-v18 src/market.ts):
 *   • portfolioId / expectedSequence(=matcherSequence) / positionEpoch(=matcherPositionEpoch)
 *       → parsePortfolioV17(portfolioAccount)
 *   • marketId (asset i)  → AssetStateV16.market_id = u64 at
 *       assetProfileOff(i) + V17_ASSET_ORACLE_WRAPPER_LEN (engine slot offset 0)
 *   • authorityEpoch      → AssetControlSequencesV17.authorityEpoch (asset 0), CAS,
 *       pass the CURRENT value (NOT +1)
 *   • observationSequence → AssetControlSequencesV17.oracleObservation (asset 0) + 1
 *       (strictly-increasing replay nonce)
 *   • protocolFeeAuthorityEpoch → parseProtocolFeeAuthorityEpoch (market-wide, only
 *       for WithdrawProtocolFee)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  parsePortfolioV17,
  parseAssetControlSequencesV17,
  parseProtocolFeeAuthorityEpoch,
  type AssetControlSequencesV17,
  type CrankObservationHint,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
  V17_ASSET_ORACLE_WRAPPER_LEN,
} from "@percolatorct/sdk";

/** Absolute byte offset where asset `assetIndex`'s wrapper slot starts. */
export function assetProfileOff(assetIndex: number): number {
  return V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + assetIndex * V17_MARKET_ASSET_SLOT_LEN;
}

function readU64LE(data: Uint8Array, off: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return (BigInt(view.getUint32(off + 4, true)) << 32n) | BigInt(view.getUint32(off, true));
}

/** The live portfolio identity + CAS watermarks bound by the v18 write wire. */
export interface PortfolioIdentity {
  /** Program-assigned stable portfolio id (`portfolioId` on the wire). */
  portfolioId: bigint;
  /** Per-portfolio matcher-sequence CAS watermark (`expectedSequence` on the wire). */
  matcherSequence: bigint;
  /** Position-episode counter (`positionEpoch` on the wire). */
  positionEpoch: bigint;
}

/** Parse the v18 identity trailer from raw portfolio account bytes. */
export function readPortfolioIdentity(portfolioData: Uint8Array): PortfolioIdentity {
  const p = parsePortfolioV17(portfolioData);
  return {
    portfolioId: p.portfolioId,
    matcherSequence: p.matcherSequence,
    positionEpoch: p.matcherPositionEpoch,
  };
}

/**
 * `market_id` for an asset = AssetStateV16.market_id (offset 0 of the engine
 * slot). Equals `assetIndex + 1` on a fresh market, but we READ it rather than
 * assume (fail-closed).
 */
export function readAssetMarketId(slabData: Uint8Array, assetIndex = 0): bigint {
  const off = assetProfileOff(assetIndex) + V17_ASSET_ORACLE_WRAPPER_LEN;
  if (slabData.length < off + 8) {
    throw new Error(`slab too short for AssetStateV16.market_id @ ${off}`);
  }
  return readU64LE(slabData, off);
}

/** Live AssetControlSequencesV16 (oracle-observation nonce + authority-epoch CAS). */
export function readAssetControlSeqs(slabData: Uint8Array, assetIndex = 0): AssetControlSequencesV17 {
  return parseAssetControlSequencesV17(slabData, assetProfileOff(assetIndex));
}

/** Market-wide `protocol_fee_authority_epoch` (only for WithdrawProtocolFee). */
export function readProtocolFeeAuthorityEpoch(slabData: Uint8Array): bigint {
  return parseProtocolFeeAuthorityEpoch(slabData, assetProfileOff(0));
}

/**
 * Default PermissionlessCrank observation hint — one entry for asset 0 with no
 * oracle-account push (a plain maintenance/fee-sweep crank). Mirrors the gate's
 * `market.ts` default (`[{ assetIndex, oracleAccounts: 0 }]`).
 */
export function defaultCrankObservations(assetIndex = 0): CrankObservationHint[] {
  return [{ assetIndex, oracleAccounts: 0 }];
}

// ── Connection-based convenience readers (fetch + parse) ────────────────────

async function fetchData(connection: Connection, pk: PublicKey): Promise<Uint8Array> {
  const info = await connection.getAccountInfo(pk, "confirmed");
  if (!info?.data) throw new Error(`account not found: ${pk.toBase58()}`);
  return new Uint8Array(info.data);
}

export async function fetchPortfolioIdentity(
  connection: Connection,
  portfolio: PublicKey,
): Promise<PortfolioIdentity> {
  return readPortfolioIdentity(await fetchData(connection, portfolio));
}

export async function fetchAssetMarketId(
  connection: Connection,
  slab: PublicKey,
  assetIndex = 0,
): Promise<bigint> {
  return readAssetMarketId(await fetchData(connection, slab), assetIndex);
}

export async function fetchAssetControlSeqs(
  connection: Connection,
  slab: PublicKey,
  assetIndex = 0,
): Promise<AssetControlSequencesV17> {
  return readAssetControlSeqs(await fetchData(connection, slab), assetIndex);
}
