/**
 * Should a trade/close be preceded by a PermissionlessCrank on the TAKER's own portfolio?
 *
 * useTrade used to PREPEND that crank to the trade, in the same transaction, whenever the
 * taker had an active leg. Measured on devnet (2026-10-01, wrapper bd4fe5f8, a fresh
 * non-creator wallet, the app's own builders, 12 rounds per market): the trade ALONE
 * simulated clean 72/72, while crank + trade in ONE tx failed the trade with Custom(21)
 * EngineLockActive on most rounds (PERC long 9/12, short 10/12; SI long 10/12). 21 is a
 * "waitable" refusal, so the ticket sat on "Waiting for the latest price" for every trader
 * holding a position: adds, flips and closes (useClosePosition goes through trade()).
 *
 * So the crank is never put in the trade's transaction. It is only sent at all when the
 * trade alone is refused AND the crank alone simulates clean (e.g. a taker portfolio that
 * needs its own maintenance first), and then as a SEPARATE, prior transaction; the trade
 * is then simulated afresh by sendTx as usual. A lagging engine clock is not this path's
 * job: lib/self-heal.ts catches it up by cranking the market's LP, and only keeps those
 * cranks when the healed list simulates without a repairable refusal.
 */
import type { TransactionInstruction } from "@solana/web3.js";

export interface TakerCrankSim {
  err: unknown;
  /** The simulation RPC itself failed: no verdict. */
  rpcFailed: boolean;
}

export type TakerCrankPlan = "none" | "separate-tx";

export async function planTakerCrank(
  simulate: (instructions: TransactionInstruction[]) => Promise<TakerCrankSim>,
  tradeIxs: TransactionInstruction[],
  crankIx: TransactionInstruction,
): Promise<TakerCrankPlan> {
  const alone = await simulate(tradeIxs);
  if (alone.rpcFailed || !alone.err) return "none";
  const crank = await simulate([crankIx]);
  if (crank.rpcFailed || crank.err) return "none";
  return "separate-tx";
}
