/**
 * Shared builder for the keeper-register stateless deployer-proof message,
 * imported by BOTH the client signer (hooks/useCreateMarket.ts) and the
 * server verifier (app/api/playground/keeper-register/route.ts) so the two
 * can never drift. Client-safe (no server-only deps).
 *
 * The message binds:
 *   - slabAddress    — which market this authorizes
 *   - dexPoolAddress — the pricing pool being authorized (SEC: previously
 *                      omitted, so a captured signature could be replayed
 *                      within the tolerance window with a DIFFERENT pool to
 *                      repoint the keeper's price source; binding it makes the
 *                      signature specific to the exact pool)
 *   - unixMinute     — Math.floor(Date.now()/60000); the server reconstructs a
 *                      small window of candidate minutes to absorb clock skew
 */
export const KEEPER_PROOF_PREFIX = "keeper-register";

export function buildKeeperProofMessage(
  slabAddress: string,
  dexPoolAddress: string,
  unixMinute: number,
): string {
  return `${KEEPER_PROOF_PREFIX}:${slabAddress}:${dexPoolAddress}:${unixMinute}`;
}
