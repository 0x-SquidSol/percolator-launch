"use client";

/**
 * Claim creator fees on one market or on many, from the /my-markets dashboard.
 *
 * `useCreatorClaim` can only claim the market its SlabProvider is bound to,
 * which is why the claim UI was one panel per row's expand drawer. This hook
 * takes slab addresses, so the dashboard can offer a claim button per market and
 * a single "claim all".
 *
 * ONE TRANSACTION PER MARKET, ONE APPROVAL (UX WP-9, audit §3.11 MM-1). Batching every claim
 * into one transaction would fail as a unit: tag 90 is CAS-bound to asset 0's `authority_epoch`,
 * so if any one market's epoch moves between read and send, the creator claims NOTHING. So each
 * market stays its own transaction (a partial success banks the markets that worked), but all of
 * them are signed with ONE signAll (lib/one-approval.ts): each is simulated first, a refused one
 * is reported and never signed.
 *
 * Bytes are fetched per market immediately before building, never reused from a
 * render-time snapshot — the amount on the wire must match the counter the
 * instruction debits.
 */

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import type { TransactionInstruction } from "@solana/web3.js";
import { broadcastSignedTx, buildBatchTx, getFreshBlockhash, getPriorityFee, signAllCompat, simulateForGate } from "@/lib/tx";
import { sizeComputeUnitLimit } from "@/lib/compute-budget";
import { runOneApproval } from "@/lib/one-approval";
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

/** CU cap for one tag-90 claim tx (sized from its simulation below the cap). */
export const CLAIM_CU_CAP = 200_000;

/** A guard failure already reads well; anything else goes through the shared mapper. */
function claimErrorText(err: unknown): string {
  if (err instanceof CreatorFeeClaimError) return err.message;
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  return mapCreatorClaimError(raw);
}

/**
 * The result line (audit §3.11): "Claimed {total} from {n} markets." and, on a partial result,
 * "Claimed {x} from {n-k} markets. {k} couldn't be claimed right now; we'll show them here."
 */
export function claimAllResultCopy(outcomes: readonly ClaimOutcome[], fmt: (atoms: bigint) => string): string | null {
  const ok = outcomes.filter((o) => o.signature);
  const bad = outcomes.length - ok.length;
  if (outcomes.length === 0) return null;
  const total = ok.reduce((a, o) => a + (o.amount ?? 0n), 0n);
  const n = ok.length;
  const head = `Claimed ${fmt(total)} from ${n} market${n === 1 ? "" : "s"}.`;
  if (bad === 0) return head;
  if (n === 0) return `${bad} market${bad === 1 ? "" : "s"} couldn't be claimed right now; we'll show ${bad === 1 ? "it" : "them"} here.`;
  return `${head} ${bad} couldn't be claimed right now; we'll show them here.`;
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

      // Read at send time, per the module note above; a market that cannot build is reported.
      const results = new Map<string, ClaimOutcome>();
      const units: { key: string; instructions: TransactionInstruction[]; amount: bigint }[] = [];
      for (const slab of slabs) {
        try {
          const market = new PublicKey(slab);
          const info = await connection.getAccountInfo(market);
          if (!info?.data) throw new CreatorFeeClaimError("Market account not found.");
          const built = await buildCreatorFeeClaimIx({ programId, market, raw: new Uint8Array(info.data), claimant: wallet.publicKey });
          units.push({ key: slab, instructions: [built.instruction], amount: built.amount });
        } catch (err) {
          results.set(slab, { slab, error: claimErrorText(err) });
        }
      }
      if (units.length > 0) {
        const payer = wallet.publicKey;
        const [blockhash, fee] = await Promise.all([getFreshBlockhash(connection, true), getPriorityFee(connection)]);
        const outcomes = await runOneApproval(units, {
          simulate: async (ixs) => {
            const g = await simulateForGate(connection, payer, ixs);
            return { err: g.err, consumed: g.consumed };
          },
          build: (ixs, consumed, i) =>
            buildBatchTx({ instructions: ixs, computeUnits: sizeComputeUnitLimit(consumed, { cap: CLAIM_CU_CAP }), priorityFeeMicroLamports: fee + i, blockhash, feePayer: payer }),
          signAll: (txs) => signAllCompat(wallet, txs),
          broadcast: (tx) => broadcastSignedTx(connection, tx),
        });
        for (const [i, o] of outcomes.entries()) {
          const u = units[i]!;
          results.set(u.key, o.ok ? { slab: u.key, signature: o.signature, amount: u.amount } : { slab: u.key, error: claimErrorText(o.error) });
          setProgress((p) => ({ ...p, done: p.done + 1 }));
        }
      }
      const ordered = slabs.map((slab) => results.get(slab)!);
      setOutcomes(ordered);
      setProgress({ current: null, done: slabs.length, total: slabs.length });
      setBusy(false);
      return ordered;
    },
    [wallet, connection],
  );

  const reset = useCallback(() => {
    setOutcomes([]);
    setProgress({ current: null, done: 0, total: 0 });
  }, []);

  return { claim, busy, progress, outcomes, reset };
}
