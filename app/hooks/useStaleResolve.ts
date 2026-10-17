"use client";

/**
 * A market whose last good price is >= its stale window behind can be settled by anyone (wrapper tag 39). On a matured-stale market
 * trades, deposits and withdrawals all refuse, so a trader is stuck until somebody settles it. This hook reads the status from the
 * market bytes (lib/v22/stale-resolve.ts) and, on the user's click ONLY, sends [tag 39] and then, if the wallet has funds there,
 * the existing resolved-exit flow (CloseResolved 30 / 46 + ClosePortfolio, lib/limits/own-portfolio-cleanup.ts). Every send is
 * simulated first; refusals 21 / 19 / 27 map to one calm line each. Nothing is ever sent without the click.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { deriveVaultAuthority } from "@percolatorct/sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useClusterSlot } from "@/hooks/useClusterSlot";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx, simulateForGate } from "@/lib/tx";
import { parseCustomInstructionError } from "@/lib/self-heal";
import { CLEANUP_CU, cleanupOwnPortfoliosBeforeReclaim } from "@/lib/limits/own-portfolio-cleanup";
import { errorText } from "@/lib/error-text";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import {
  STALE_SETTLE_COPY,
  buildResolveStalePermissionlessIxV22,
  showStaleSettle,
  staleMinutes,
  staleResolveRefusalCopy,
  staleResolveStatusV22,
  type StaleResolveStatusV22,
} from "@/lib/v22/stale-resolve";

export interface StaleSettleView {
  minutes: number;
  status: StaleResolveStatusV22;
}

export interface StaleResolveState {
  /** Non-null only on a Live, matured-stale v2.2 market. */
  view: StaleSettleView | null;
  busy: boolean;
  error: string | null;
  /** The one line shown after a click that worked. */
  done: string | null;
  settle: () => Promise<void>;
}

/** Thrown for a refusal that already has its one calm line. */
class CalmRefusal extends Error {}

export function useStaleResolve(slabAddress: string | null, hasFunds: boolean): StaleResolveState {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { raw, programId, config, refresh } = useSlabState();
  const clusterSlot = useClusterSlot(isDevnetV22Enabled());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const inFlight = useRef(false);

  const status = useMemo(() => (isDevnetV22Enabled() ? staleResolveStatusV22(raw, clusterSlot) : null), [raw, clusterSlot]);
  const view = useMemo<StaleSettleView | null>(() => (showStaleSettle(status) ? { minutes: staleMinutes(status.ageSlots), status } : null), [status]);

  const settle = useCallback(async () => {
    if (inFlight.current) return;
    if (!slabAddress || !programId || !config || !wallet.publicKey) {
      setError(STALE_SETTLE_COPY.generic);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setDone(null);
    const payer = wallet.publicKey;
    const market = new PublicKey(slabAddress);
    try {
      // Fresh read: the cached bytes may be a poll behind, and a price push (or another settler) changes the answer.
      const [info, slot] = await Promise.all([connection.getAccountInfo(market, "confirmed"), connection.getSlot("confirmed")]);
      const fresh = info ? staleResolveStatusV22(new Uint8Array(info.data), BigInt(slot)) : null;
      if (!fresh) throw new CalmRefusal(STALE_SETTLE_COPY.generic);
      let settledNow = false;
      if (fresh.refusalCode === null) {
        const ix = buildResolveStalePermissionlessIxV22(programId, market, BigInt(slot));
        const sim = await simulateForGate(connection, payer, [ix]);
        if (sim.err) {
          const code = parseCustomInstructionError(sim.err)?.code;
          if (code === 21) {
            // Settled by someone else between the read and now: carry on to the exit.
          } else {
            throw new CalmRefusal((code !== undefined ? staleResolveRefusalCopy(code) : null) ?? STALE_SETTLE_COPY.generic);
          }
        } else {
          await sendTx({ connection, wallet, instructions: [ix], computeUnits: 200_000 });
          settledNow = true;
        }
      } else if (fresh.refusalCode !== 21) {
        throw new CalmRefusal(staleResolveRefusalCopy(fresh.refusalCode) ?? STALE_SETTLE_COPY.generic);
      }
      void settledNow;
      if (!hasFunds) {
        setDone(STALE_SETTLE_COPY.settledNoFunds);
        return;
      }
      const [vaultAuthority] = deriveVaultAuthority(programId, market);
      const out = await cleanupOwnPortfoliosBeforeReclaim({
        connection,
        programId,
        market,
        owner: payer,
        collateralMint: config.collateralMint,
        vaultToken: getAssociatedTokenAddressSync(config.collateralMint, vaultAuthority, true),
        vaultAuthority,
        send: (ixs) => sendTx({ connection, wallet, instructions: ixs, computeUnits: CLEANUP_CU }),
      });
      // "others-remain" only says other traders still hold accounts (it matters for reclaiming the slab, not for this wallet's funds).
      if (out.ok || out.reason === "others-remain") setDone(STALE_SETTLE_COPY.settled);
      else setDone(STALE_SETTLE_COPY.settledPayoutSoon);
    } catch (e) {
      if (e instanceof CalmRefusal) setError(e.message);
      else {
        const msg = errorText(e);
        setError(/reject|declin|cancel/i.test(msg) ? STALE_SETTLE_COPY.cancelled : STALE_SETTLE_COPY.generic);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      refresh();
    }
  }, [slabAddress, programId, config, wallet, connection, hasFunds, refresh]);

  return { view, busy, error, done, settle };
}
