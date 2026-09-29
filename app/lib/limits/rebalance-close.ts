/**
 * F-3 / R1: close a position with the owner-signed unilateral exit (RebalanceReduce,
 * tag 44) while the asset is ADL reduce-only. Mirrors the #519 harness sequence
 * (`f3_owner_exits`): refresh the holder's portfolio with a permissionless crank, then tag 44
 * signed by the owner — both in ONE user transaction (the P0b self-heal still applies).
 * Tag 44's capacity is min(eff, oi_long, oi_short), so a close can be PARTIAL: the result is
 * measured (lib/limits/fill-check.ts), never assumed.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { sendTx } from "@/lib/tx";
import { fetchPortfolioIdentity } from "@/lib/v18-wire";
import { buildRebalanceCloseIxs } from "./rebalance-ixs";
import { measureFill } from "./fill-check";
import { signedPositionForAsset } from "./decode";
import { extractErrorCode } from "@/lib/errorMessages";
import type { FillResult } from "./fill-result";

export { buildRebalanceCloseIxs };
type SendTxWallet = Parameters<typeof sendTx>[0]["wallet"];

export interface RebalanceCloseParams {
  connection: Connection;
  wallet: SendTxWallet;
  programId: PublicKey;
  market: PublicKey;
  owner: PublicKey;
  portfolio: PublicKey;
  /** Signed position before the close (base q). */
  beforeQ: bigint;
  reduceQ: bigint;
  marketId: bigint;
  pythCrankAccount: PublicKey | null;
  assetIndex?: number;
}

/** Custom(18) EngineInvalidLeg: tag 44 on a leg that no longer exists. */
export const ENGINE_INVALID_LEG = 18;

export async function closeViaRebalanceReduce(p: RebalanceCloseParams): Promise<{ signature: string | null; fill: FillResult }> {
  const id = await fetchPortfolioIdentity(p.connection, p.portfolio);
  const instructions = buildRebalanceCloseIxs({ ...p, portfolioId: id.portfolioId, positionEpoch: id.positionEpoch });
  let signature: string;
  try {
    signature = await sendTx({
      connection: p.connection,
      wallet: p.wallet,
      instructions,
      computeUnits: 600_000,
      selfHeal: { programId: p.programId, market: p.market },
    });
  } catch (e) {
    // Race seen in the #519 scenario: another holder's unilateral close ADLs the matching
    // opposite OI and flattens THIS position before our tx lands => Custom(18). If a fresh read
    // shows the leg is gone, the position IS closed: report that, not an error.
    const msg = e instanceof Error ? e.message : String(e);
    if (extractErrorCode(msg) === ENGINE_INVALID_LEG) {
      const info = await p.connection.getAccountInfo(p.portfolio, "confirmed").catch(() => null);
      const now = info ? signedPositionForAsset(new Uint8Array(info.data), p.assetIndex ?? 0, p.marketId) : null;
      if (now === 0n) return { signature: null, fill: { kind: "full", filledQ: -p.beforeQ } };
    }
    throw e;
  }
  const requested = p.beforeQ > 0n ? -p.reduceQ : p.reduceQ;
  const fill = await measureFill(p.connection, p.portfolio, signature, p.beforeQ, requested, p.marketId, p.assetIndex ?? 0);
  return { signature, fill };
}
