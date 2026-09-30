/**
 * d119eebd senior draw: client self-repair for the two new Earn refusals, in the user's OWN
 * transaction (same shape as vault-lp-repair.ts, run right after it in sendTx):
 *
 *  - 87 VaultLpSeniorDrawRequired (75/77 found an undrawn deficit on a READ-ONLY vault LP):
 *    prepend the permissionless vault-LP crank (it runs the draw), re-simulate, keep it only
 *    if the 87 is gone. The app passes the vault LP writable, so this is a safety net.
 *  - 88 VaultLpRedeemNeedsRecall (E2E B24; 77's pot cannot fund the payout because part of
 *    the senior value sits in the vault LP after a draw and a recovery): insert a
 *    permissionless 98 VaultLpRecall into the redeemer's pot just before the 77. The amount
 *    is estimated from the program's own `recall_limit(C_eff, cover)` inputs as the app
 *    reads them; because the program's cover is ledger-based, a few descending candidates are
 *    SIMULATED and the first that makes the whole tx succeed is kept. None works (the LP has
 *    open positions, or the market is not Live) => unchanged, and the user sees 88's copy.
 *
 * Never throws. Any RPC failure => unchanged.
 */
import { PublicKey, Transaction, VersionedTransaction, type AccountMeta, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { computeBudgetPrefix, parseCustomInstructionError, REPAIR_CU, type SimResult } from "@/lib/self-heal";
import { P3_ERR, TAG_EXECUTE_REDEMPTION } from "./constants";
import { decodeAssetVaultLp, decodeMarketEngineView, decodePortfolioRisk, decodeTerminalBacking, decodeVaultLpState, type VaultLpStateView } from "./decode";
import { buildVaultLpRecallIx, type VaultLpMarket } from "./p3-ix";
import { effectiveSeniorClaim, harvestableFeeAtoms, recallLimit, vaultLpValueAtoms } from "./vault-tranche";
import { buildVaultLpCrankIx, isVaultLpSelfHealEnabled } from "./vault-lp-repair";

const MAX_TX_CU = 1_400_000;
/** 98 costs ~62k CU on BPF (d119eebd sim); margin on top of the caller's limit. */
export const RECALL_CU = 120_000;

export function drawRepairFailure(
  err: unknown,
  txInstructions: readonly TransactionInstruction[],
  wrapperProgramId: PublicKey,
): { code: 87 | 88; index: number } | null {
  const p = parseCustomInstructionError(err);
  if (!p) return null;
  if (p.code !== P3_ERR.VaultLpSeniorDrawRequired && p.code !== P3_ERR.VaultLpRedeemNeedsRecall) return null;
  const ix = txInstructions[p.index];
  if (!ix || !ix.programId.equals(wrapperProgramId)) return null;
  return { code: p.code as 87 | 88, index: p.index };
}

/**
 * Recall amounts to try, most likely first: the app's estimate of `recall_limit(C_eff, cover)`
 * (C_eff = effective senior claim with pending fees, cover = the pair's physical backing +
 * harvestable fees), capped at the vault LP's value (39b138c8 D-P3-30: a recall may never take
 * the LP's certified equity below zero), then smaller fractions (the program's ledger-based
 * cover can read higher). `lpValueAtoms` null = unknown (not capped; the simulation decides).
 */
export function recallCandidates(
  market: Uint8Array,
  vs: VaultLpStateView,
  registryDomain: number,
  lpValueAtoms: bigint | null = null,
): bigint[] {
  const eng = decodeMarketEngineView(market, Math.floor(registryDomain / 2));
  const tb = decodeTerminalBacking(market, registryDomain);
  if (!eng || !tb) return [];
  const h = harvestableFeeAtoms(eng) ?? 0n;
  const cEff = effectiveSeniorClaim(vs.seniorClaimAtoms, h, vs.seniorFeeShareBps);
  if (cEff === null) return [];
  const base = recallLimit(cEff, tb.physical + h);
  const est = lpValueAtoms === null ? base : base < lpValueAtoms ? base : lpValueAtoms > 0n ? lpValueAtoms : 0n;
  const out: bigint[] = [];
  for (const a of [est, (est * 3n) / 4n, est / 2n, est / 4n]) if (a > 0n && !out.includes(a)) out.push(a);
  return out;
}

/** The 77 account list (buildEarnExecuteIxs + bound tail): the accounts 98 needs. */
export function recallIxFor77(ix77: TransactionInstruction, cranker: PublicKey, amount: bigint): TransactionInstruction {
  if (ix77.data[0] !== TAG_EXECUTE_REDEMPTION || ix77.keys.length < 15) throw new Error("not a bound 77");
  const k = (i: number): PublicKey => (ix77.keys[i] as AccountMeta).pubkey;
  const domain = ix77.data.length >= 3 ? ix77.data[1] | (ix77.data[2] << 8) : 0;
  const vm: VaultLpMarket = {
    programId: ix77.programId,
    market: k(1),
    registry: k(2),
    ledger: k(8),
    siblingLedger: k(11),
    vaultLpState: k(13),
    lpPortfolio: k(14),
  };
  return buildVaultLpRecallIx(vm, cranker, amount, domain);
}

/** `ixs` with a 98 recall of `amount` inserted right before the 77 at index `at`. */
export function withRecallBefore77(ixs: readonly TransactionInstruction[], at: number, cranker: PublicKey, amount: bigint): TransactionInstruction[] {
  const ix77 = ixs[at];
  if (!ix77) throw new Error("no 77 at index");
  return [...ixs.slice(0, at), recallIxFor77(ix77, cranker, amount), ...ixs.slice(at)];
}

/** Index of the (single) wrapper 77 in `ixs`, or -1. */
export function find77(ixs: readonly TransactionInstruction[], programId: PublicKey): number {
  return ixs.findIndex((ix) => ix.programId.equals(programId) && ix.data[0] === TAG_EXECUTE_REDEMPTION);
}

export interface SeniorDrawRepairDeps {
  read: (pk: PublicKey) => Promise<Uint8Array | null>;
  simulate: (instructions: TransactionInstruction[]) => Promise<SimResult>;
}

export interface SeniorDrawRepairParams {
  programId: PublicKey;
  market: PublicKey;
  cranker: PublicKey;
  instructions: TransactionInstruction[];
  computeUnits: number;
  oracleTail?: readonly AccountMeta[];
}

export type SeniorDrawRepairOutcome =
  | "disabled"
  | "user-tx-ok"
  | "not-repairable"
  | "cranked"
  | "recalled"
  | "repair-did-not-help"
  | "rpc-error";

export interface SeniorDrawRepairResult {
  instructions: TransactionInstruction[];
  computeUnits: number;
  outcome: SeniorDrawRepairOutcome;
  /** The recall amount kept (outcome "recalled"). */
  recallAtoms?: bigint;
}

export async function planSeniorDrawRepair(p: SeniorDrawRepairParams, deps: SeniorDrawRepairDeps): Promise<SeniorDrawRepairResult> {
  const unchanged = (outcome: SeniorDrawRepairOutcome): SeniorDrawRepairResult => ({
    instructions: p.instructions,
    computeUnits: p.computeUnits,
    outcome,
  });
  if (!isVaultLpSelfHealEnabled()) return unchanged("disabled");
  try {
    const origList = [...computeBudgetPrefix(p.computeUnits), ...p.instructions];
    const orig = await deps.simulate(origList);
    if (!orig.err) return unchanged("user-tx-ok");
    const f = drawRepairFailure(orig.err, origList, p.programId);
    if (!f) return unchanged("not-repairable");
    const prefix = origList.length - p.instructions.length;
    const at = f.index - prefix; // index into p.instructions

    if (f.code === P3_ERR.VaultLpSeniorDrawRequired) {
      const m = await deps.read(p.market);
      const rec = m ? decodeAssetVaultLp(m, 0) : null;
      if (!rec?.bound) return unchanged("not-repairable");
      const crank = buildVaultLpCrankIx(p.programId, p.cranker, p.market, new PublicKey(rec.vaultLpPortfolio), p.oracleTail ?? []);
      const cu = Math.min(MAX_TX_CU, p.computeUnits + REPAIR_CU);
      const ixs = [crank, ...p.instructions];
      const list = [...computeBudgetPrefix(cu), ...ixs];
      const r = await deps.simulate(list);
      if (r.err && drawRepairFailure(r.err, list, p.programId)?.code === P3_ERR.VaultLpSeniorDrawRequired) return unchanged("repair-did-not-help");
      return { instructions: ixs, computeUnits: cu, outcome: "cranked" };
    }

    // 88: recall into the redeemer's pot right before the 77.
    const ix77 = p.instructions[at];
    if (!ix77 || ix77.data[0] !== TAG_EXECUTE_REDEMPTION || ix77.keys.length < 15) return unchanged("not-repairable");
    const [m, sd, lpd] = await Promise.all([deps.read(p.market), deps.read(ix77.keys[13].pubkey), deps.read(ix77.keys[14].pubkey)]);
    const vs = sd ? decodeVaultLpState(sd) : null;
    if (!m || !vs) return unchanged("not-repairable");
    const domain = ix77.data.length >= 3 ? ix77.data[1] | (ix77.data[2] << 8) : 0;
    const eng = decodeMarketEngineView(m, Math.floor(domain / 2));
    const risk = lpd ? decodePortfolioRisk(lpd) : null;
    const lpVal = eng && risk ? vaultLpValueAtoms(risk, eng) : null;
    const lpValueAtoms = lpVal && lpVal.kind !== "stale" ? lpVal.atoms : null;
    const cu = Math.min(MAX_TX_CU, p.computeUnits + RECALL_CU);
    for (const amount of recallCandidates(m, vs, domain, lpValueAtoms)) {
      const ixs = withRecallBefore77(p.instructions, at, p.cranker, amount);
      const r = await deps.simulate([...computeBudgetPrefix(cu), ...ixs]);
      if (!r.err) return { instructions: ixs, computeUnits: cu, outcome: "recalled", recallAtoms: amount };
    }
    return unchanged("repair-did-not-help");
  } catch (e) {
    console.warn("[senior-draw-repair] skipped:", e);
    return unchanged("rpc-error");
  }
}

/** Real-connection deps (same simulate shape as connectionVaultLpRepairDeps). */
export function connectionSeniorDrawRepairDeps(connection: Connection, payer: PublicKey): SeniorDrawRepairDeps {
  return {
    read: async (pk) => {
      const info = await connection.getAccountInfo(pk, "confirmed");
      return info ? new Uint8Array(info.data) : null;
    },
    simulate: async (instructions) => {
      const tx = new Transaction();
      for (const ix of instructions) tx.add(ix);
      tx.feePayer = payer;
      tx.recentBlockhash = PublicKey.default.toBase58();
      const sim = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
        replaceRecentBlockhash: true,
        sigVerify: false,
        commitment: "confirmed",
      });
      return { err: sim.value.err };
    },
  };
}
