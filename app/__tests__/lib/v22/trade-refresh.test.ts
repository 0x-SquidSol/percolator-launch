// @vitest-environment node
/** v2.2 QA U-1 / R-1 / Q-7b: the refresh-crank planner (lib/v22/trade-refresh.ts), on the Q-7 devnet fixture. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { buildRefreshCrankIxV22 } from "@/lib/v22/sdk";
import { refreshCandidatesFromAccounts } from "@/lib/v22/trade-refresh-wire";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { HealthCheckStaleError, MAX_PEER_CRANKS, marketAssetSlots, needsMultiAssetShape, planV22TradeRefresh, type RefreshSim, type TradeRefreshDeps, type TradeRefreshInput } from "@/lib/v22/trade-refresh";

interface Ser { programId: string; keys: string[]; data: string }
const FX = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-q7-devnet-2026-10-12.json"), "utf8")) as {
  market: string; portfolio: string; lp: string; owner: string;
  accounts: { market: string; taker: string; lp: string; flatPortfolio: string };
  cases: { label: string; scriptIxs: Ser[] }[];
};
const FEE = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-fee-channel-2026-10-11.json"), "utf8")) as { markets: Record<string, Record<string, string>> };
const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
const W = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const MKT = new PublicKey(FX.market), P = new PublicKey(FX.portfolio), LP = new PublicKey(FX.lp), OWNER = new PublicKey(FX.owner);
const unser = (s: Ser): TransactionInstruction => new TransactionInstruction({ programId: new PublicKey(s.programId), keys: s.keys.map((k) => { const [pk, f] = k.split(":"); return { pubkey: new PublicKey(pk), isSigner: f[0] === "s", isWritable: f[1] === "w" }; }), data: Buffer.from(s.data, "hex") });
const trade = unser(FX.cases[3].scriptIxs[FX.cases[3].scriptIxs.length - 1]);
const deposit = new TransactionInstruction({ programId: W, keys: [], data: Buffer.from([3]) });
const k = () => Keypair.generate().publicKey;
const PREFIX = 2;
const ok: RefreshSim = { err: null, logs: [] };
const at = (idx: number, code: number): RefreshSim => ({ err: { InstructionError: [PREFIX + idx, { Custom: code }] }, logs: [] });
const tagOf = (ix: TransactionInstruction) => ix.data[0];
const crankTarget = (ix: TransactionInstruction) => ix.keys[2].pubkey.toBase58();

function deps(sims: RefreshSim[], peers: PublicKey[] = []): TradeRefreshDeps & { simulate: ReturnType<typeof vi.fn>; readStalePeers: ReturnType<typeof vi.fn> } {
  const q = [...sims];
  return {
    simulate: vi.fn(async () => (q.length > 1 ? q.shift()! : q[0])),
    simPrefix: PREFIX,
    readStalePeers: vi.fn(async () => peers),
    refusal: (sim) => Object.assign(new Error("refused " + JSON.stringify(sim.err)), { name: "SimulationRefusal" }),
    sleep: async () => {},
  };
}
const multi = (over: Partial<TradeRefreshInput> = {}): TradeRefreshInput => ({
  programId: W, market: MKT, marketData: b64(FX.accounts.market), cranker: OWNER, takerPortfolio: P, takerData: b64(FX.accounts.taker), lpPortfolio: LP, lpData: b64(FX.accounts.lp), body: [trade], ...over,
});
const single = (over: Partial<TradeRefreshInput> = {}): TradeRefreshInput => multi({ marketData: b64(FEE.markets.JUP.marketB64), ...over });

describe("which shape", () => {
  it("5-asset market with 3 legs needs the multi-asset shape; a single-asset market or flat sides do not", () => {
    expect(marketAssetSlots(b64(FX.accounts.market))).toBe(5);
    expect(marketAssetSlots(b64(FEE.markets.JUP.marketB64))).toBe(1);
    expect(needsMultiAssetShape(multi())).toBe(true);
    expect(needsMultiAssetShape(multi({ takerData: b64(FX.accounts.flatPortfolio) }))).toBe(true); // the LP alone at 3 legs
    expect(needsMultiAssetShape(multi({ takerData: b64(FX.accounts.flatPortfolio), lpData: b64(FX.accounts.flatPortfolio) }))).toBe(false);
    expect(needsMultiAssetShape(single())).toBe(false);
  });
});

describe("U-1 / R-1: a 121 on a single-asset market gets the stale peers' refresh cranks in the same tx", () => {
  it("[crank peer x n, ...body] once the simulation is green; taker and LP are never cranked as peers; at most 6", async () => {
    const peers = Array.from({ length: 9 }, k);
    const d = deps([ok], [P, LP, ...peers]);
    const plan = await planV22TradeRefresh(single({ body: [deposit, trade] }), d, { withPeers: true });
    expect(plan.path).toBe("simple");
    expect(plan.cranks).toHaveLength(MAX_PEER_CRANKS);
    expect(plan.cranks.map((c) => c.portfolio.toBase58())).toEqual(peers.slice(0, 6).map((p) => p.toBase58()));
    expect(plan.instructions.slice(0, 6).map(crankTarget)).toEqual(peers.slice(0, 6).map((p) => p.toBase58()));
    expect(plan.instructions.slice(6)).toEqual([deposit, trade]);
    // The first crank OBSERVES asset 0 (it accrues the market; a refresh-only crank before any accrual is refused 22
    // and the 121 stays: measured on swordcat). The rest are refresh-only.
    expect(Buffer.from(plan.instructions[0].data).equals(Buffer.from(buildRefreshCrankIxV22(W, MKT, OWNER, peers[0], [0]).data))).toBe(true);
    expect(Buffer.from(plan.instructions[1].data).equals(Buffer.from(buildRefreshCrankIxV22(W, MKT, OWNER, peers[1], []).data))).toBe(true);
  });
  it("a peer that is already current (22) is dropped; with none left the order goes alone", async () => {
    const [a, b] = [k(), k()];
    const d = deps([at(0, 22), ok], [a, b]);
    const plan = await planV22TradeRefresh(single(), d, { withPeers: true });
    expect(plan.cranks.map((c) => c.portfolio.toBase58())).toEqual([b.toBase58()]);
    const d2 = deps([at(0, 22)], [a]);
    const p2 = await planV22TradeRefresh(single(), d2, { withPeers: true });
    expect(p2.cranks).toEqual([]);
    expect(p2.instructions).toEqual([trade]);
  });
  it("no stale peer: the body is returned unchanged and nothing is simulated", async () => {
    const d = deps([ok], []);
    const plan = await planV22TradeRefresh(single(), d, { withPeers: true });
    expect(plan.instructions).toEqual([trade]);
    expect(d.simulate).not.toHaveBeenCalled();
  });
  it("still 121 with the peers refreshed, or any other refusal: thrown as the caller's refusal", async () => {
    await expect(planV22TradeRefresh(single(), deps([at(1, 121)], [k()]), { withPeers: true })).rejects.toThrow(/refused .*121/);
    await expect(planV22TradeRefresh(single(), deps([at(1, 49)], [k()]), { withPeers: true })).rejects.toThrow(/refused .*49/);
  });
  it("without a 121 (withPeers off) a single-asset trade is never touched", async () => {
    const d = deps([ok], [k()]);
    const plan = await planV22TradeRefresh(single(), d);
    expect(plan.cranks).toEqual([]);
    expect(d.readStalePeers).not.toHaveBeenCalled();
  });
});

describe("Q-7b: >= 3 legs on a multi-asset market", () => {
  it("[LP observe, taker, LP, trade]: the SDK plan's own instructions (reference script bytes), without its budget", async () => {
    const d = deps([ok]);
    const plan = await planV22TradeRefresh(multi(), d);
    expect(plan.path).toBe("multiAsset");
    expect(plan.cranks.map((c) => c.role)).toEqual(["lpObserve", "taker", "lp"]);
    const script = FX.cases[3].scriptIxs.slice(2).map(unser); // the script's first two are the budget
    expect(plan.instructions.map((ix) => Buffer.from(ix.data).toString("hex"))).toEqual(script.map((ix) => Buffer.from(ix.data).toString("hex")));
    expect(plan.instructions.slice(0, 3).map(crankTarget)).toEqual([LP, P, LP].map((p) => p.toBase58()));
  });
  it("a refresh refused 22 is dropped; a trade still 19 gets one more refresh; the observing crank's 22 waits a slot", async () => {
    const d = deps([at(1, 22), at(2, 19), at(0, 22), ok]);
    const plan = await planV22TradeRefresh(multi(), d);
    expect(plan.cranks.map((c) => c.role)).toEqual(["lpObserve", "lp", "taker"]);
    expect(plan.rounds).toBe(4);
  });
  it("a 121 on the open reads the stale peers once and refreshes them between the LP observe crank and the taker", async () => {
    const peer = k();
    const d = deps([at(3, 121), ok], [peer]);
    const plan = await planV22TradeRefresh(multi(), d);
    expect(plan.cranks.map((c) => c.role)).toEqual(["lpObserve", "peer", "taker", "lp"]);
    expect(d.readStalePeers).toHaveBeenCalledTimes(1);
  });
  it("19 after every refinement: HealthCheckStaleError (never the 'goes through automatically' wait)", async () => {
    const d = deps([{ err: { InstructionError: [0, { Custom: 0 }] }, logs: [] }]);
    d.simulate.mockImplementation(async (ixs: TransactionInstruction[]) => at(ixs.length - 1, 19));
    await expect(planV22TradeRefresh(multi(), d)).rejects.toBeInstanceOf(HealthCheckStaleError);
  });
  it("a deposit in front of the trade keeps its place after the cranks; another refusal is the caller's", async () => {
    const plan = await planV22TradeRefresh(multi({ body: [deposit, trade] }), deps([ok]));
    expect(plan.instructions.slice(3)).toEqual([deposit, trade]);
    expect(plan.instructions.slice(0, 3).map(tagOf)).toEqual([5, 5, 5]);
    await expect(planV22TradeRefresh(multi(), deps([at(3, 49)]))).rejects.toThrow(/refused .*49/);
  });
});

describe("refresh candidates and copy", () => {
  beforeEach(() => __setDevnetV22ForTest(true));
  afterEach(() => __setDevnetV22ForTest(null));
  it("every POSITIONED portfolio of the market is a candidate (stale flags are not the 121 rule); flat ones and other markets are not", () => {
    const [a, b, c] = [k(), k(), k()];
    const rows = [
      { pubkey: a, data: b64(FX.accounts.flatPortfolio) },
      { pubkey: b, data: b64(FX.accounts.taker) },
      { pubkey: c, data: b64(FX.accounts.lp) },
    ];
    const got = refreshCandidatesFromAccounts(rows, MKT).map((p) => p.toBase58());
    expect(got.sort()).toEqual([b.toBase58(), c.toBase58()].sort());
    expect(refreshCandidatesFromAccounts(rows, k())).toEqual([]);
    expect(refreshCandidatesFromAccounts([{ pubkey: a, data: new Uint8Array(40) }], MKT)).toEqual([]);
  });
  it("HealthCheckStaleError resolves to a clear 'Not sent' line, never 'goes through automatically'", () => {
    const m = resolveUserMessage(new HealthCheckStaleError(new Error("19")), { surface: "trade" });
    expect(m.kind).toBe("health-check-stale");
    expect(m.body).toBe("These positions needed more refreshing than fits in one go, so nothing was sent. Try again in a moment.");
    expect(m.body).not.toMatch(/automatically/);
    expect(m.autoRetry).toBeFalsy();
  });
});
