/**
 * The app's dependencies for lib/v22/trade-refresh.ts: the gate simulation (wrapper heap + 1.4M limit), the stale-peer
 * scan (the same owner/market scan the Earn exit uses) and the refusal error. Flag-gated by the callers.
 */
import type { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { simulateForGate, SimulationRefusal } from "@/lib/tx";
import { parsePortfolio, portfolioScanFilters } from "./layout";
import { planV22TradeRefresh, type TradeRefreshDeps, type TradeRefreshInput, type TradeRefreshPlan } from "./trade-refresh";

/**
 * Refresh candidates for a 121, from raw portfolio rows of ONE market: every POSITIONED portfolio, flagged-stale legs
 * first, then the oldest price/funding snapshot (`kfEpochSnap`) first. The per-leg stale flags are NOT the 121 rule:
 * on swordcat (2026-10-12) the standing long that blocked every open had `stale = false`, and its only sign was a
 * snapshot behind the market's. The planner drops a candidate the program reports as already current (22), so the
 * list is deliberately every positioned account, not a guess at the program's bound.
 */
export function refreshCandidatesFromAccounts(rows: readonly { pubkey: PublicKey; data: Uint8Array }[], market: PublicKey): PublicKey[] {
  const out: { key: PublicKey; flagged: boolean; snap: bigint }[] = [];
  for (const r of rows) {
    let pf: ReturnType<typeof parsePortfolio>;
    try {
      pf = parsePortfolio(r.data);
    } catch {
      continue;
    }
    if (!pf.marketGroupId.equals(market)) continue;
    const active = pf.legs.filter((l) => l.active);
    if (active.length === 0) continue;
    const snaps = active.map((l) => BigInt((l as { kfEpochSnap?: bigint | number }).kfEpochSnap ?? 0));
    out.push({ key: r.pubkey, flagged: active.some((l) => l.stale || l.bStale), snap: snaps.reduce((a, b) => (b < a ? b : a)) });
  }
  out.sort((a, b) => (a.flagged !== b.flagged ? (a.flagged ? -1 : 1) : a.snap !== b.snap ? (a.snap < b.snap ? -1 : 1) : a.key.toBase58() < b.key.toBase58() ? -1 : 1));
  return out.map((o) => o.key);
}

/** Positioned portfolios of `market` to refresh on a 121, most stale first. A failed scan is "none" (the order then waits as before). */
export async function scanStalePeers(connection: Connection, programId: PublicKey, market: PublicKey): Promise<PublicKey[]> {
  try {
    const f = portfolioScanFilters();
    const rows = await connection.getProgramAccounts(programId, {
      commitment: "confirmed",
      filters: [{ dataSize: f.dataSize }, ...(f.versionMemcmp ? [{ memcmp: f.versionMemcmp }] : []), { memcmp: { offset: 16, bytes: market.toBase58() } }],
    });
    return refreshCandidatesFromAccounts(rows.map((r) => ({ pubkey: r.pubkey, data: new Uint8Array(r.account.data) })), market);
  } catch {
    return [];
  }
}

export function tradeRefreshDeps(connection: Connection, programId: PublicKey, market: PublicKey, cranker: PublicKey): TradeRefreshDeps {
  return {
    simulate: async (ixs: TransactionInstruction[]) => {
      const g = await simulateForGate(connection, cranker, ixs);
      return { err: g.err, logs: g.logs, simulated: g.simulated };
    },
    simPrefix: 2, // simulateForGate: heap frame + compute-unit limit
    readStalePeers: () => scanStalePeers(connection, programId, market),
    refusal: (sim, ixs) => new SimulationRefusal(sim.err, [...sim.logs], [...(sim.simulated ?? ixs)]),
  };
}

/** Read the two trade portfolios and plan. `takerPortfolio` null = a first trade that creates the account. */
export async function planTradeRefresh(
  connection: Connection,
  i: Omit<TradeRefreshInput, "takerData" | "lpData">,
  opts: { withPeers?: boolean } = {},
): Promise<TradeRefreshPlan> {
  const keys = i.takerPortfolio ? [i.takerPortfolio, i.lpPortfolio] : [i.lpPortfolio];
  const infos = await connection.getMultipleAccountsInfo(keys, "confirmed").catch(() => [] as (null | { data: Uint8Array })[]);
  const takerData = i.takerPortfolio && infos[0] ? new Uint8Array(infos[0].data) : null;
  const lpInfo = i.takerPortfolio ? infos[1] : infos[0];
  const lpData = lpInfo ? new Uint8Array(lpInfo.data) : null;
  return planV22TradeRefresh({ ...i, takerData, lpData }, tradeRefreshDeps(connection, i.programId, i.market, i.cranker), opts);
}
