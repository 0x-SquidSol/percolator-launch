/**
 * v2.2 QA U-1 / R-1 / Q-7b: the refresh cranks a trade needs in its own transaction.
 *
 * Two program rules the app did not satisfy (wrapper RC 6c078a0e):
 *  - 121 EngineLossStale: a risk-increasing order is refused while another POSITIONED portfolio on the market is
 *    stale and insurance does not cover its hidden-loss bound. The app only waited for the keeper's sweep, so an
 *    open hung on "Refreshing positions" for as long as the peer stayed stale. A PermissionlessCrank of the stale
 *    peer in the same transaction clears it (QA R-1: the swordcat open landed once the standing long was cranked).
 *  - 19 EngineStale on a MULTI-ASSET market once the taker or the LP holds >= 3 legs: both need a health certificate
 *    at the market's current epochs. The shape is the SDK's `buildMultiAssetTradeIxsV22` (port of percolator-sdk
 *    418f0cd): [crank LP observing every asset, crank stale peers, crank taker, crank LP, trade], refined by
 *    `refineMultiAssetTradePlanV22` (drop a crank refused 22, append on a 19).
 *
 * This module plans those cranks by SIMULATION (nothing is signed), bounded by a round limit and a peer limit; the
 * caller sends `[...cranks, ...body]` through sendTx, which sizes the compute limit from its own simulation (up to
 * the 1.4M transaction maximum). Pure orchestration: every RPC is a dependency, so the rules are unit-tested.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  buildMultiAssetTradeIxsV22,
  buildRefreshCrankIxV22,
  refineMultiAssetTradePlanV22,
  resolveMarketGeometry,
  v22Slab,
  WRAPPER_PRE_CRANK_MIN_LEGS_V22,
  type MultiAssetTradePlanV22,
} from "./sdk";

/** Stale peers refreshed in one transaction (each ~114k CU and one more account; 6 keeps the tx inside 1.4M CU / 1,232 B). */
export const MAX_PEER_CRANKS = 6;
/** Simulation rounds before the plan gives up. */
export const MAX_REFRESH_ROUNDS = 10;
export const ERR_ENGINE_STALE = 19;
export const ERR_NON_PROGRESS = 22;
export const ERR_LOSS_STALE = 121;

export interface RefreshSim {
  err: unknown;
  logs: readonly string[];
  /** The full simulated list (budget instructions included), for attributing the failing instruction. */
  simulated?: readonly TransactionInstruction[];
}

export interface TradeRefreshInput {
  programId: PublicKey;
  market: PublicKey;
  /** Raw market bytes (asset-slot count). */
  marketData: Uint8Array;
  cranker: PublicKey;
  /** The taker's portfolio; null on a first trade that creates it in this transaction. */
  takerPortfolio: PublicKey | null;
  takerData: Uint8Array | null;
  lpPortfolio: PublicKey;
  lpData: Uint8Array | null;
  /** The instructions to run after the cranks; the LAST one is the trade. */
  body: readonly TransactionInstruction[];
}

export interface TradeRefreshDeps {
  /** Simulate `ixs` as the cranker with the wrapper heap + a 1.4M limit. `prefix` = budget instructions it adds in front. */
  simulate: (ixs: TransactionInstruction[]) => Promise<RefreshSim>;
  /** Budget instructions `simulate` puts in front (lib/tx simulateForGate: 2). */
  simPrefix: number;
  /** Stale positioned portfolios of this market, most urgent first (lib/v22/earn-exit staleCandidatesFromAccounts). */
  readStalePeers: () => Promise<PublicKey[]>;
  /** Turn a failed simulation into the error to throw (lib/tx SimulationRefusal). */
  refusal: (sim: RefreshSim, ixs: TransactionInstruction[]) => Error;
  sleep?: (ms: number) => Promise<void>;
}

export interface TradeRefreshPlan {
  path: "simple" | "multiAsset";
  /** `[...cranks, ...body]`. */
  instructions: TransactionInstruction[];
  /** The cranks in front, by role. */
  cranks: { role: "lpObserve" | "peer" | "taker" | "lp"; portfolio: PublicKey }[];
  rounds: number;
}

/** The multi-asset refusal after every refinement: the account's health check could not be brought current here. */
export class HealthCheckStaleError extends Error {
  constructor(cause: unknown) {
    super("These positions needed more refreshing than fits in one go, so nothing was sent. Try again in a moment.", { cause });
    this.name = "HealthCheckStaleError";
  }
}

/** Asset slots of the market (1 on a single-asset market). null when the bytes are not a known market layout. */
export function marketAssetSlots(marketData: Uint8Array): number | null {
  try {
    const g = resolveMarketGeometry(marketData, { parser: "marketAssetSlots", strictLength: false });
    return new DataView(marketData.buffer, marketData.byteOffset, marketData.byteLength).getUint32(g.groupOff + g.layout.group.config + g.layout.group.maxMarketSlotsInConfig, true);
  } catch {
    return null;
  }
}

function activeLegs(data: Uint8Array | null): number {
  if (!data) return 0;
  try {
    return v22Slab.parsePortfolioV17(data).legs.filter((l) => l.active).length;
  } catch {
    return 0;
  }
}

/** True when the Q-7 shape is needed: a multi-asset market and the taker or the LP at >= 3 legs. */
export function needsMultiAssetShape(i: Pick<TradeRefreshInput, "marketData" | "takerData" | "lpData">): boolean {
  const slots = marketAssetSlots(i.marketData);
  return slots !== null && slots > 1 && Math.max(activeLegs(i.takerData), activeLegs(i.lpData)) >= WRAPPER_PRE_CRANK_MIN_LEGS_V22;
}

function codeAt(err: unknown): { index: number; code: number | null } | null {
  const ie = (err as { InstructionError?: [number, unknown] } | null | undefined)?.InstructionError;
  if (!Array.isArray(ie) || typeof ie[0] !== "number") return null;
  const inner = ie[1] as { Custom?: unknown } | null;
  return { index: ie[0], code: inner && typeof inner === "object" && typeof inner.Custom === "number" ? inner.Custom : null };
}

const sameKey = (a: PublicKey, b: PublicKey | null) => b !== null && a.equals(b);

/**
 * Plan the cranks. `withPeers`: start by reading the stale peers (the caller already saw a 121). Returns the body
 * unchanged (`cranks: []`) when nothing is needed. Throws `deps.refusal(...)` for a refusal no refresh fixes, and
 * HealthCheckStaleError when the multi-asset shape still returns 19 after every refinement.
 */
export async function planV22TradeRefresh(i: TradeRefreshInput, deps: TradeRefreshDeps, opts: { withPeers?: boolean } = {}): Promise<TradeRefreshPlan> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const body = [...i.body];
  const tradeIx = body[body.length - 1];
  const pre = body.slice(0, -1);
  const multi = i.takerPortfolio !== null && i.takerData !== null && i.lpData !== null && needsMultiAssetShape(i);
  let peers: PublicKey[] = [];
  let peersRead = false;
  const loadPeers = async (): Promise<boolean> => {
    if (peersRead) return false;
    peersRead = true;
    const all = (await deps.readStalePeers()).filter((p) => !sameKey(p, i.takerPortfolio) && !p.equals(i.lpPortfolio));
    peers = all.slice(0, MAX_PEER_CRANKS);
    return peers.length > 0;
  };
  if (opts.withPeers) await loadPeers();

  if (multi) {
    const build = (): MultiAssetTradePlanV22 =>
      buildMultiAssetTradeIxsV22({
        programId: i.programId, market: i.market, marketData: i.marketData, cranker: i.cranker,
        takerPortfolio: i.takerPortfolio as PublicKey, takerData: i.takerData as Uint8Array, lpPortfolio: i.lpPortfolio, lpData: i.lpData as Uint8Array,
        tradeIx, stalePeers: peers, forcePath: "multiAsset",
      });
    let plan = build();
    for (let round = 1; round <= MAX_REFRESH_ROUNDS; round++) {
      const crankIxs = plan.instructions.slice(plan.budgetIxs.length, plan.budgetIxs.length + plan.cranks.length);
      const ixs = [...crankIxs, ...pre, tradeIx];
      const sim = await deps.simulate(ixs);
      if (!sim.err) return { path: "multiAsset", instructions: ixs, cranks: plan.cranks.map((c) => ({ role: c.role, portfolio: c.portfolio })), rounds: round };
      const at = codeAt(sim.err);
      // Map the simulated index onto the SDK plan's own numbering: [budget..., cranks..., trade].
      const j = at ? at.index - deps.simPrefix : -1;
      const planIndex = j >= 0 && j < plan.cranks.length ? j : j === ixs.length - 1 ? plan.cranks.length : -1;
      if (at && planIndex === plan.cranks.length && at.code === ERR_LOSS_STALE && (await loadPeers())) {
        plan = build();
        continue;
      }
      if (!at || planIndex < 0) throw deps.refusal(sim, ixs);
      const next = refineMultiAssetTradePlanV22(plan, { InstructionError: [plan.budgetIxs.length + planIndex, { Custom: at.code }] });
      if (next.action === "fail") {
        if (next.code === ERR_ENGINE_STALE) throw new HealthCheckStaleError(deps.refusal(sim, ixs));
        throw deps.refusal(sim, ixs);
      }
      if (next.action === "wait") await sleep(700);
      plan = next.plan;
    }
    throw new HealthCheckStaleError(new Error("refresh rounds exhausted"));
  }

  // Single-asset market (or both sides below 3 legs): only stale peers can be needed, and only after a 121.
  if (peers.length === 0) return { path: "simple", instructions: body, cranks: [], rounds: 0 };
  let cranks = [...peers];
  for (let round = 1; round <= MAX_REFRESH_ROUNDS; round++) {
    // The FIRST crank observes the traded asset: it accrues the market to this slot, and only then is a peer "behind"
    // (a refresh-only crank before any accrual is refused 22: the peer is current against the STORED epoch, and the
    // trade's own accrual is what makes it stale; measured on swordcat 2026-10-12). The rest are refresh-only.
    const ixs = [...cranks.map((p, n) => buildRefreshCrankIxV22(i.programId, i.market, i.cranker, p, n === 0 ? [0] : [])), ...body];
    const sim = await deps.simulate(ixs);
    if (!sim.err) return { path: "simple", instructions: ixs, cranks: cranks.map((p) => ({ role: "peer" as const, portfolio: p })), rounds: round };
    const at = codeAt(sim.err);
    const j = at ? at.index - deps.simPrefix : -1;
    // A peer that is already current (22) is dropped; with none left the body goes alone.
    if (at && at.code === ERR_NON_PROGRESS && j >= 0 && j < cranks.length) {
      cranks = cranks.filter((_, k) => k !== j);
      if (cranks.length === 0) return { path: "simple", instructions: body, cranks: [], rounds: round };
      continue;
    }
    throw deps.refusal(sim, ixs);
  }
  throw deps.refusal({ err: { InstructionError: [0, { Custom: ERR_LOSS_STALE }] }, logs: [] }, body);
}
