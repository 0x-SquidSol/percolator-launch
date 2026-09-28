/**
 * What it takes to close (reclaim) a v18 market, decided from its bytes alone.
 *
 * CloseSlab (wrapper tag 13) only accepts a RESOLVED market (header.mode == 1)
 * with no user capital (c_tot == 0) and no portfolios; anything else fails with
 * EngineLockActive (Custom 21). InitMarket leaves a market Live, so a market whose
 * creation stopped part-way needs ResolveMarket (tag 19) first — without it,
 * reclaiming a half-created market could never succeed (tester report
 * 2026-09-28, market CaS8oiDW…: "reclaim transaction fails", 0x15).
 *
 * Both instructions are signed by marketauth, which is still the creator until
 * the launch's stake InitPool step rotates it to the pool PDA.
 */
import { readAssetControlSeqs, readMarketGroupHeader } from "@/lib/v18-wire";

export type CloseMarketPlan =
  | {
      ok: true;
      /** asset 0's authority_epoch — ResolveMarket CHECKS it without advancing, so CloseSlab binds the same value. */
      authorityEpoch: bigint;
      /** Present when the market is still Live: send ResolveMarket before CloseSlab, in the same tx. */
      resolve: { assetGenerationFrontier: bigint } | null;
    }
  | { ok: false; reason: "holds-capital" };

export function planCloseMarket(slabData: Uint8Array): CloseMarketPlan {
  const authorityEpoch = readAssetControlSeqs(slabData, 0).authorityEpoch;
  const hdr = readMarketGroupHeader(slabData);
  if (hdr.mode !== 0) return { ok: true, authorityEpoch, resolve: null };
  if (hdr.cTot !== 0n || hdr.materializedPortfolioCount !== 0n) {
    return { ok: false, reason: "holds-capital" };
  }
  return { ok: true, authorityEpoch, resolve: { assetGenerationFrontier: hdr.nextMarketId } };
}
