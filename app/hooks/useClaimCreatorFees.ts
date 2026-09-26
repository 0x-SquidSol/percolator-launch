"use client";

/**
 * Claim creator fees on one market or on many, from the /my-markets dashboard.
 *
 * `useCreatorClaim` can only claim the market its SlabProvider is bound to,
 * which is why the claim UI was one panel per row's expand drawer. This hook
 * takes slab addresses, so the dashboard can offer a claim button per market and
 * a single "claim all".
 *
 * ONE TRANSACTION PER MARKET, DELIBERATELY. Batching every claim into one
 * transaction would need one signature instead of N, but tag 90 is CAS-bound to
 * asset 0's `authority_epoch`: if any one market's epoch moves between read and
 * send, a batched transaction fails as a unit and the creator claims NOTHING.
 * Sequential sends make each market independent, so a partial success banks the
 * markets that worked. For money, partial success beats all-or-nothing.
 *
 * Bytes are fetched per market immediately before building, never reused from a
 * render-time snapshot — the amount on the wire must match the counter the
 * instruction debits.
 */

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { sendTx } from "@/lib/tx";
import { getConfig } from "@/lib/config";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { buildCreatorFeeClaimIx, CreatorFeeClaimError } from "@/lib/creator-fee-claim-ix";
import { mapCreatorClaimError } from "@/lib/creatorClaimError";

export interface ClaimOutcome {
  slab: string;
  /** Transaction signature on success. */
  signature?: string;
  /** User-facing reason on failure — already passed through mapCreatorClaimError. */
  error?: string;
  /** Atoms actually submitted, for the success message. */
  amount?: bigint;
}

export interface ClaimProgress {
  /** Slab currently being submitted, or null when idle. */
  current: string | null;
  done: number;
  total: number;
}

export function useClaimCreatorFees() {
  const wallet = useWalletCompat();
  const { connection } = useConnectionCompat();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ClaimProgress>({ current: null, done: 0, total: 0 });
  const [outcomes, setOutcomes] = useState<ClaimOutcome[]>([]);

  const claim = useCallback(
    async (slabs: readonly string[]): Promise<ClaimOutcome[]> => {
      if (slabs.length === 0) return [];
      if (!wallet.publicKey || !wallet.signTransaction) {
        const failed = slabs.map((slab) => ({ slab, error: "Wallet not connected" }));
        setOutcomes(failed);
        return failed;
      }

      const programId = new PublicKey(getConfig().programId as string);
      assertKnownProgram(programId.toBase58());

      setBusy(true);
      setOutcomes([]);
      setProgress({ current: null, done: 0, total: slabs.length });

      const results: ClaimOutcome[] = [];
      for (const slab of slabs) {
        setProgress((p) => ({ ...p, current: slab }));
        try {
          const market = new PublicKey(slab);
          // Read at send time, per the module note above.
          const info = await connection.getAccountInfo(market);
          if (!info?.data) throw new CreatorFeeClaimError("Market account not found.");

          const built = await buildCreatorFeeClaimIx({
            programId,
            market,
            raw: new Uint8Array(info.data),
            claimant: wallet.publicKey,
          });
          const sig = await sendTx({ connection, wallet, instructions: [built.instruction] });
          results.push({
            slab,
            signature: typeof sig === "string" ? sig : undefined,
            amount: built.amount,
          });
        } catch (err) {
          const rawMsg = err instanceof Error ? err.message : String(err);
          // A guard failure already reads well; anything else goes through the
          // shared mapper so on-chain codes become sentences.
          results.push({
            slab,
            error: err instanceof CreatorFeeClaimError ? rawMsg : mapCreatorClaimError(rawMsg),
          });
        } finally {
          setProgress((p) => ({ ...p, done: p.done + 1 }));
        }
        // Publish incrementally so a long claim-all shows what has landed.
        setOutcomes([...results]);
      }

      setProgress({ current: null, done: slabs.length, total: slabs.length });
      setBusy(false);
      return results;
    },
    [wallet, connection],
  );

  const reset = useCallback(() => {
    setOutcomes([]);
    setProgress({ current: null, done: 0, total: 0 });
  }, []);

  return { claim, busy, progress, outcomes, reset };
}
