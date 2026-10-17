// @vitest-environment node
/**
 * The create-market WIZARD's v2.2 wire, against the v2.2 wrapper 6kpg2wi7 (devnet), byte for byte.
 *
 * What it runs: the wizard's own derivations (deriveLaunchMarketParams -> defaultGrowthLaunch -> planLaunchV22 -> toLaunchParams ->
 * wizardP3Params, exactly as components/create/CreateMarketWizard.tsx builds `CreateMarketParams`) through the REAL hook
 * (attemptFreshBatchedLaunch). The single launch transaction it signs is decoded and its InitMarket checked against the v2.2 SDK's
 * encoders:
 *   - offline, always: golden bytes (generated from @percolator/sdk feat/v22-sdk-growth a18c199 `encodeInitMarketV22`) and the
 *     slab length (4,059 B = 592 + 806 + 2,661), the order of the tags, and the tier-binding tail of tag 94;
 *   - with SDK_V22_DIST=<dir of the built SDK candidate>: the same bytes recomputed by the SDK itself;
 *   - with WIZARD_SIM=1 (network): the launch transaction is SIMULATED (never sent) on devnet against the wrapper, with a
 *     throwaway funded key (WIZARD_SIM_KEY=<keypair json>), sigVerify off. The result is appended to WIZARD_SIM_OUT.
 *
 * Environment (set before the app modules load): the v2.2 fresh program set is selected through the app's own override
 * (NEXT_PUBLIC_WRAPPER_PROGRAM_ID + NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE), flags V21 + V22 on. LIMITS_P3 is deliberately NOT set
 * here: the point of the first block is that the v2.2 target must use the v2.2 wire without it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { Connection, Keypair, PublicKey, SystemProgram, type Transaction } from "@solana/web3.js";
import { IX_TAG, IX_TAG_P3, STAKE_IX, type InitMarketV17Args } from "@percolatorct/sdk";

const h = vi.hoisted(async () => {
  const { Keypair: Kp } = await import("@solana/web3.js");
  const seed = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : (i * 7 + n) & 0xff));
  const keeper = Kp.fromSeed(seed(202));
  process.env.PLAYGROUND_KEEPER_KEYPAIR = JSON.stringify(Array.from(keeper.secretKey));
  process.env.NEXT_PUBLIC_WRAPPER_PROGRAM_ID = "6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM";
  process.env.NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE = "1";
  process.env.NEXT_PUBLIC_DEVNET_V22 = "1";
  process.env.NEXT_PUBLIC_DEVNET_V21 = "1";
  delete process.env.NEXT_PUBLIC_LIMITS_P3;
  delete process.env.NEXT_PUBLIC_LIMITS_P3_WIZARD;
  return {
    keeper,
    seed,
    depsFactory: null as unknown as ((a: { cosign: import("@/lib/launch-single-tx/deps").KeeperCosignRequestBase }) => import("@/lib/launch-single-tx/run").SingleTxLaunchDeps) | null,
    signAllCompat: (await import("vitest")).vi.fn(),
    broadcastSignedTx: (await import("vitest")).vi.fn(),
    presimulateOrThrow: (await import("vitest")).vi.fn(async () => undefined),
    saveInFlightMarket: (await import("vitest")).vi.fn(),
    validBlockhashes: new Set<string>(),
    rent: (n: number) => 1_000_000 + n,
    blockhash: "GHtXQBpHnMXhoLGsryeDY7i6bGqTC2LGqS11Kf3rKmFS",
  };
});

vi.mock("@/lib/tx", async (orig) => {
  const s = await h;
  return {
    ...(await orig<typeof import("@/lib/tx")>()),
    signAllCompat: s.signAllCompat,
    broadcastSignedTx: s.broadcastSignedTx,
    presimulateOrThrow: s.presimulateOrThrow,
    getFreshBlockhash: vi.fn(async () => s.blockhash),
    getPriorityFee: vi.fn(async () => 50_000),
    prewarmTxLanding: vi.fn(),
  };
});
vi.mock("@/lib/inFlightMarket", async () => {
  const s = await h;
  return { saveInFlightMarket: s.saveInFlightMarket, updateInFlightStep: vi.fn(), clearInFlightMarket: vi.fn(), loadLastInFlightMarket: vi.fn(() => null) };
});
vi.mock("@/lib/launch-single-tx/deps", async (orig) => {
  const s = await h;
  return { ...(await orig<typeof import("@/lib/launch-single-tx/deps")>()), liveSingleTxDeps: (a: { cosign: import("@/lib/launch-single-tx/deps").KeeperCosignRequestBase }) => s.depsFactory!(a) };
});
vi.mock("@/lib/server-rpc", async () => {
  const s = await h;
  return {
    getServerConnection: () => ({
      getSlot: async () => 5_000,
      getLatestBlockhash: async () => ({ blockhash: s.blockhash, lastValidBlockHeight: 99 }),
      getAccountInfo: async () => null,
      getMinimumBalanceForRentExemption: async (n: number) => s.rent(n),
      isBlockhashValid: async (bh: string) => ({ context: { slot: 5_000 }, value: s.validBlockhashes.has(bh) }),
    }),
  };
});

import { attemptFreshBatchedLaunch, type CreateMarketParams, type CreateMarketState } from "@/hooks/useCreateMarket";
import { getConfig } from "@/lib/config";
import { DEVNET_PROGRAM_IDS, DEVNET_V22_PROGRAM_IDS } from "@/lib/program-ids";
import { POST as cosignPOST } from "@/app/api/playground/keeper-cosign/route";
import { requestKeeperV1Signature, type KeeperCosignRequestBase } from "@/lib/launch-single-tx/deps";
import type { LaunchSigStatus, SingleTxLaunchDeps } from "@/lib/launch-single-tx/run";
import { decodeV1Message } from "@/lib/launch-single-tx/v1-decode";
import { splitV1Wire, type RawTxSigner } from "@/lib/tx-v1";
import { simulateV1ViaProxy } from "@/lib/tx-v1/rpc";
import { resetCosignV1RateLimits } from "@/lib/launch-single-tx/cosign-rate-limit";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setLimitsFlagsForTest, limitsFlags, p3WizardEnabled } from "@/lib/limits/flags";
import { __setLotMarketsEnabledForTest } from "@/lib/v22/lot";
import { buildV17InitMarketArgs, slabSizeFor } from "@/lib/create-market-args";
import { deriveLaunchMarketParams } from "@/lib/market-params";
import { defaultGrowthLaunch, type GrowthLaunch } from "@/lib/v21/growth-launch";
import { planLaunchV22, toLaunchParams } from "@/lib/v22/launch-plan";
import { canonicalVaultLpMatcher, wizardP3Params } from "@/lib/limits/p3-wizard";
import { encodeInitMarket } from "@percolatorct/sdk";
import { encodeInitMarketV22, encodeInitMarketTrailerV22, LAYOUT_V22 } from "@/lib/v22/sdk";

__setLotMarketsEnabledForTest(true);

const S = await h;
const seed = S.seed;
const SIM = process.env.WIZARD_SIM === "1";
const KEY_FILE = process.env.WIZARD_SIM_KEY;
const SIM_OUT = process.env.WIZARD_SIM_OUT;
const WALLET = SIM && KEY_FILE ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY_FILE, "utf8")) as number[])) : Keypair.fromSeed(seed(201));
const V22_COLLATERAL = new PublicKey("ERe2nVetnKFH4Am7hh1cVWXd52s7uhWjorwFkU61kwan");
const MINT = SIM ? V22_COLLATERAL : new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC");
const POOL = Keypair.fromSeed(seed(203)).publicKey;
const PROGRAM = new PublicKey(DEVNET_V22_PROGRAM_IDS.wrapper);
const DEVNET = SIM ? new Connection("https://api.devnet.solana.com", "confirmed") : null;

// ---------------------------------------------------------------- the wizard's own derivation
/** What components/create/CreateMarketWizard.tsx hands to create(), for a keeper-priced token at `tokenPriceE6`, P3 on or off. */
function wizardParams(opts: { p3: boolean; tokenPriceE6: bigint }): CreateMarketParams {
  const initialMarginBps = 2_000;
  const tradingFeeBps = 30;
  const lpCollateral = 1_000_000_000n; // the wizard's Liquidity amount, 1,000 test USDC
  const derived = deriveLaunchMarketParams({ initialMarginBps, lpCollateral: 0n, initialPriceE6: 1_000_000n });
  // wizard: growthAvailable = isDevnetV21Enabled() && p3WizardEnabled(); growth only when the creator turned it on (default on in these cases)
  const growthLaunch: GrowthLaunch | undefined = opts.p3
    ? defaultGrowthLaunch({ engineImrBps: derived.initialMarginBps, maintenanceMarginBps: derived.maintenanceMarginBps, maxPriceMoveBpsPerSlot: derived.maxPriceMoveBpsPerSlot, baseFeeBps: tradingFeeBps })
    : undefined;
  const plan = growthLaunch ? planLaunchV22({ tokenPriceE6: opts.tokenPriceE6, collateralDecimals: 6, collateralSymbol: "TST", oracleMode: "keeper", growthOn: true }) : null;
  const v22 = plan ? toLaunchParams(plan) : undefined;
  const launchPrice = v22 ? opts.tokenPriceE6 * 10n ** BigInt(v22.lotExp) : opts.tokenPriceE6;
  return {
    mint: MINT,
    initialPriceE6: launchPrice,
    lpCollateral,
    insuranceAmount: 100_000_000n,
    oracleFeed: "0".repeat(64),
    invert: false,
    tradingFeeBps,
    initialMarginBps,
    ...(growthLaunch ? { growth: { ...growthLaunch, collateralDecimals: 6 } } : {}),
    ...(v22 ? { v22 } : {}),
    p3: wizardP3Params(opts.p3, lpCollateral, 2_000),
    symbol: "TST",
    name: "Test",
    decimals: 6,
    oracleMode: "keeper",
    dexPoolAddress: POOL.toBase58(),
    dexType: "raydium-clmm",
    mainnetCA: POOL.toBase58(),
  };
}

// ---------------------------------------------------------------- harness (same shape as useCreateMarket.v22-launch.test.ts)
let generated = 0;
let stateBox: CreateMarketState;
let sent: Uint8Array[] = [];
let simulated: Uint8Array[] = [];
/** Legacy-format batch txs the wallet was asked to sign (captured; the stub then stops the batch before broadcast). */
let batches: Transaction[][] = [];
let simResults: { err: unknown; logs: string[] | null; unitsConsumed?: number }[] = [];

const realFetch = globalThis.fetch;
/** Stop a batched launch at the wallet prompt, keeping the legacy txs it asked the wallet to sign. */
function captureBatches(): void {
  S.signAllCompat.mockImplementation(async (_w: unknown, txs: Transaction[]) => {
    batches.push(txs);
    throw new Error("stop: batch captured before broadcast");
  });
}
async function routeFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (u.startsWith("https://api.devnet.solana.com")) return realFetch(url, init);
  if (u.includes("keeper-cosign")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return cosignPOST(new NextRequest("http://localhost/api/playground/keeper-cosign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }
  return new Response("{}", { status: 200 });
}

const fakeSigner: RawTxSigner = {
  source: "wallet-adapter",
  name: "FakeV1",
  versions: new Set<unknown>(["legacy", 0, 1]),
  supportsV1: true,
  async signRaw(wires) {
    return wires.map((w) => {
      const { message } = splitV1Wire(w);
      const out = new Uint8Array(w);
      out.set(ed25519.sign(message, WALLET.secretKey.slice(0, 32)), message.length);
      return out;
    });
  },
};

function deps(cosign: KeeperCosignRequestBase): SingleTxLaunchDeps {
  let t = 0;
  return {
    simulate: async (wire) => {
      simulated.push(wire);
      if (SIM && DEVNET) {
        const r = await simulateV1ViaProxy(DEVNET, wire);
        simResults.push({ err: r.err, logs: r.logs ?? null, unitsConsumed: r.unitsConsumed });
        return r;
      }
      return { err: null, logs: [], unitsConsumed: 477_473, loadedAccountsDataSize: 2_770_000 };
    },
    keeperSign: async (m) => requestKeeperV1Signature(cosign, m, routeFetch as typeof fetch),
    walletSign: async (wire) => (await fakeSigner.signRaw([wire]))[0]!,
    send: async (wire) => {
      sent.push(wire);
      return "sig";
    },
    status: async (): Promise<LaunchSigStatus> => ({ kind: "confirmed" }),
    blockHeight: async () => 0,
    slabExists: async () => false,
    sleep: async () => undefined,
    now: () => (t += 1_000),
  };
}

function freshState(): CreateMarketState {
  return { batchFallbackReason: null, step: 0, stepLabel: "", txSigs: [], slabAddress: null, error: null, loading: false, devnetMint: null, insuranceMintFailed: false, backingSeedFailed: false, keeperDelegated: false, keeperMessage: null, keeperRegistering: false, priceFeedRequired: false, phase: "idle", landingIndex: 0, landingTotal: 0 };
}

async function launch(params: CreateMarketParams) {
  generated = 0;
  const slabKp = Keypair.fromSeed(seed(77));
  S.depsFactory = (a) => deps(a.cosign);
  const outcome = await attemptFreshBatchedLaunch({
    connection: {
      rpcEndpoint: "http://127.0.0.1:1",
      getAccountInfo: vi.fn(async () => null),
      getMinimumBalanceForRentExemption: vi.fn(async (n: number) => (DEVNET ? DEVNET.getMinimumBalanceForRentExemption(n) : S.rent(n))),
      getBalance: vi.fn(async () => 50_000_000_000),
      getLatestBlockhash: vi.fn(async () => ({ blockhash: S.blockhash, lastValidBlockHeight: 1_000 })),
    } as unknown as Connection,
    wallet: { publicKey: WALLET.publicKey, signTransaction: async (tx: Transaction) => tx, signAllTransactions: async (txs: Transaction[]) => txs },
    programId: PROGRAM,
    slabKp,
    params,
    isDevnetEnv: true,
    isKeeperOracle: true,
    isAdminOracle: false,
    isHyperpOracle: false,
    oracleMode: "keeper",
    setState: (u) => {
      stateBox = u(stateBox);
    },
    singleTx: { rawSigner: fakeSigner },
  });
  return { outcome, slab: slabKp.publicKey };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Keypair, "generate").mockImplementation(() => Keypair.fromSeed(seed(100 + generated++)));
  vi.spyOn(globalThis, "fetch").mockImplementation(routeFetch as typeof fetch);
  stateBox = freshState();
  sent = [];
  simulated = [];
  simResults = [];
  batches = [];
  S.signAllCompat.mockReset();
  S.validBlockhashes = new Set([S.blockhash]);
  resetCosignV1RateLimits();
  __setDevnetV22ForTest(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  __setLimitsFlagsForTest(null);
});
afterAll(() => __setDevnetV22ForTest(null));

const progOf = (d: ReturnType<typeof decodeV1Message>, i: number) => d.accountKeys[d.instructions[i]!.programIdIndex]!;
const tagOf = (d: ReturnType<typeof decodeV1Message>, i: number) => d.instructions[i]!.data[0];
const kinds = (d: ReturnType<typeof decodeV1Message>) =>
  d.instructions.map((_, i) => `${progOf(d, i).equals(PROGRAM) ? "w" : progOf(d, i).toBase58() === DEVNET_V22_PROGRAM_IDS.stake ? "s" : "x"}${tagOf(d, i)}`);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** The launch transaction the wizard asks the network to simulate before the wallet prompt (the same message it then signs and sends). */
function decodeLaunch() {
  expect(simulated.length).toBeGreaterThan(0);
  return decodeV1Message(splitV1Wire(simulated[simulated.length - 1]!).message);
}
function initMarketData(d: ReturnType<typeof decodeV1Message>): Uint8Array {
  const at = d.instructions.findIndex((x, i) => progOf(d, i).equals(PROGRAM) && x.data[0] === IX_TAG.InitMarket);
  expect(at).toBeGreaterThanOrEqual(0);
  return d.instructions[at]!.data;
}

function record(label: string, extra: Record<string, unknown>) {
  if (SIM_OUT) appendFileSync(SIM_OUT, JSON.stringify({ label, wrapper: PROGRAM.toBase58(), payer: WALLET.publicKey.toBase58(), ...extra }, (_, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
}

// ---------------------------------------------------------------- the wire
const TOKEN_PRICE_E6 = 2_500_000n; // $2.50 a token: planLaunchV22 picks the lot (a lot of 10^k tokens) from the price

describe("wizard -> v2.2 wrapper: the program set and the slab", () => {
  it("the env override selects the v2.2 fresh set (wrapper 6kpg2wi7, nft 27LWmR72, stake 7JrgAUHi)", () => {
    expect(getConfig().programId).toBe(DEVNET_V22_PROGRAM_IDS.wrapper);
    expect(getConfig().programId).not.toBe(DEVNET_PROGRAM_IDS.wrapper);
  });
  it("the slab is v2.2 sized (4,059 B for one asset) whether or not P3 is on: it follows the V22 flag, not the P3 flag", () => {
    expect(LAYOUT_V22.marketGroupOff + LAYOUT_V22.marketGroupLen + LAYOUT_V22.assetSlotStride).toBe(4_059);
    __setLimitsFlagsForTest({ p1: false, p2: false, p2FeeCharged: false, p3: false });
    expect(slabSizeFor(wizardParams({ p3: false, tokenPriceE6: TOKEN_PRICE_E6 }))).toBe(4_059);
    __setLimitsFlagsForTest({ p1: true, p2: true, p2FeeCharged: true, p3: true });
    expect(slabSizeFor(wizardParams({ p3: true, tokenPriceE6: TOKEN_PRICE_E6 }))).toBe(4_059);
  });
});

describe("wizard -> v2.2 wrapper: the vault-LP matcher pre-check", () => {
  it("accepts the v2.2 wrapper's canonical matcher (AsHvEJ8z) as well as the v2 one, and refuses any other", () => {
    expect(canonicalVaultLpMatcher(DEVNET_V22_PROGRAM_IDS.matcher).toBase58()).toBe("AsHvEJ8zNctKmdeS57H5E4w6nkTLi3bPVpd6ZCLc2ayN");
    expect(canonicalVaultLpMatcher(DEVNET_PROGRAM_IDS.matcher).toBase58()).toBe(DEVNET_PROGRAM_IDS.matcher);
    expect(() => canonicalVaultLpMatcher(POOL.toBase58())).toThrow(/canonical vault-LP matcher/);
  });
  it("the configured matcher of the v2.2 set is the one the wizard passes (no fallback at the bind)", () => {
    expect(getConfig().matcherProgramId).toBe(DEVNET_V22_PROGRAM_IDS.matcher);
  });
});

describe("wizard -> v2.2 wrapper: InitMarket bytes (P3 on, V22 on: the intended v2.2 launch)", () => {
  it("InitMarket == SDK encodeInitMarketV22(base args, merged trailer): growth(4) lot(1) rent(6) band(18) = 29 B; one transaction", async () => {
    __setLimitsFlagsForTest({ p1: true, p2: true, p2FeeCharged: true, p3: true });
    const params = wizardParams({ p3: true, tokenPriceE6: TOKEN_PRICE_E6 });
    expect(params.v22?.lotExp).toBeGreaterThan(0);
    expect(params.v22?.rent).toBeDefined();
    expect(params.v22?.band).toBeDefined();
    const { outcome } = await launch(params);
    if (!SIM) expect(outcome).toEqual({ status: "success" }); // with the real network the harness's fake wallet/cluster ends the run after the simulation
    const d = decodeLaunch();
    const data = initMarketData(d);
    const args: InitMarketV17Args = buildV17InitMarketArgs(params, deriveLaunchMarketParams({ initialMarginBps: params.initialMarginBps, lpCollateral: params.lpCollateral, initialPriceE6: params.initialPriceE6 }));
    // the wizard sends the growth block's fee cap / funding ceiling inside the base args
    const g = params.growth!;
    const expectedBase = encodeInitMarket({ ...args, maxTradingFeeBps: g.maxTradingFeeBps.toString(), maxAbsFundingE9PerSlot: g.maxAbsFundingE9PerSlot.toString() });
    const trailer = encodeInitMarketTrailerV22({ rGapBps: g.rGapBps, lLaunchX100: g.lLaunchX100, lotExp: params.v22!.lotExp, rent: params.v22!.rent!, band: params.v22!.band! });
    expect(trailer).toHaveLength(29);
    const expected = encodeInitMarketV22({ ...args, maxTradingFeeBps: g.maxTradingFeeBps.toString(), maxAbsFundingE9PerSlot: g.maxAbsFundingE9PerSlot.toString() }, { rGapBps: g.rGapBps, lLaunchX100: g.lLaunchX100, lotExp: params.v22!.lotExp, rent: params.v22!.rent!, band: params.v22!.band! });
    expect(hex(data)).toBe(hex(expected));
    expect(hex(data.subarray(0, expectedBase.length))).toBe(hex(expectedBase));
    expect(hex(data.subarray(expectedBase.length))).toBe(hex(trailer));
    // the launch order: 0 (InitMarket) first among wrapper tags, tag 94 binds the vault LP, the stake pool is last
    const k = kinds(d);
    expect(k.indexOf("w0")).toBeGreaterThanOrEqual(0);
    expect(k.indexOf("w74")).toBeGreaterThan(k.indexOf("w0"));
    expect(k.indexOf("w94")).toBeGreaterThan(k.indexOf("w74"));
    expect(k.indexOf("w96")).toBeGreaterThan(k.indexOf("w94"));
    expect(k.indexOf(`s${STAKE_IX.InitPool}`)).toBeGreaterThan(k.indexOf("w94"));
    expect(IX_TAG_P3.InitVaultLp).toBe(94);
    record("p3-on-v22-launch", { initMarketHex: hex(data), instructionKinds: k, bytes: simulated[simulated.length - 1]!.length, slabBytes: slabSizeFor(params) });
  });

  it("the SDK candidate itself produces the same bytes (SDK_V22_DIST=<dir>)", async () => {
    const dir = process.env.SDK_V22_DIST;
    if (!dir || !existsSync(`${dir}/dist/index.js`)) return; // network-free CI: the golden test above is the pin
    __setLimitsFlagsForTest({ p1: true, p2: true, p2FeeCharged: true, p3: true });
    const params = wizardParams({ p3: true, tokenPriceE6: TOKEN_PRICE_E6 });
    await launch(params);
    const data = initMarketData(decodeLaunch());
    const sdk = (await import(/* @vite-ignore */ `${dir}/dist/index.js`)) as { encodeInitMarketV22: (a: InitMarketV17Args, t: Record<string, unknown>) => Uint8Array };
    const g = params.growth!;
    const args = buildV17InitMarketArgs(params, deriveLaunchMarketParams({ initialMarginBps: params.initialMarginBps, lpCollateral: params.lpCollateral, initialPriceE6: params.initialPriceE6 }));
    const expected = sdk.encodeInitMarketV22(
      { ...args, maxTradingFeeBps: g.maxTradingFeeBps.toString(), maxAbsFundingE9PerSlot: g.maxAbsFundingE9PerSlot.toString() },
      { rGapBps: g.rGapBps, lLaunchX100: g.lLaunchX100, lotExp: params.v22!.lotExp, rent: params.v22!.rent!, band: params.v22!.band! },
    );
    expect(hex(data)).toBe(hex(expected));
  });
});

describe("wizard -> v2.2 wrapper: with LIMITS_P3 unset (the claim)", () => {
  it("the wizard derives NO growth / v2.2 block, so the launch is the legacy base InitMarket (tag + 218 B body, no trailer) in the batched path, into a 4,059 B slab", async () => {
    __setLimitsFlagsForTest(null);
    expect(limitsFlags().p3).toBe(false);
    expect(p3WizardEnabled()).toBe(false);
    const params = wizardParams({ p3: false, tokenPriceE6: TOKEN_PRICE_E6 });
    expect(params.growth).toBeUndefined();
    expect(params.v22).toBeUndefined();
    captureBatches();
    await launch(params); // the single-tx shape is the P3 launch only: this falls back to the batch, which the stub captures
    expect(sent).toHaveLength(0);
    const m1 = batches[0]?.[0];
    expect(m1).toBeDefined();
    const im = m1!.instructions.find((x) => x.programId.equals(PROGRAM) && x.data[0] === IX_TAG.InitMarket);
    expect(im).toBeDefined();
    const args = buildV17InitMarketArgs(params, deriveLaunchMarketParams({ initialMarginBps: params.initialMarginBps, lpCollateral: params.lpCollateral, initialPriceE6: params.initialPriceE6 }));
    expect(hex(im!.data)).toBe(hex(encodeInitMarket(args)));
    expect(im!.data.length).toBe(219); // tag + the 218-byte body
    const create = m1!.instructions.find((x) => x.programId.equals(SystemProgram.programId));
    expect(Buffer.from(create!.data).readBigUInt64LE(12)).toBe(BigInt(slabSizeFor(params)));
    expect(slabSizeFor(params)).toBe(4_059);
    record("p3-unset-m1", { initMarketHex: hex(im!.data), m1Instructions: m1!.instructions.length });
  });
});

// ---------------------------------------------------------------- simulation (network, opt-in)
describe.skipIf(!SIM || !KEY_FILE)("DEVNET SIMULATION of the wizard's launch transaction against the v2.2 wrapper (never sent)", () => {
  it("P3 on + V22 on: simulateTransaction of the whole single launch tx", async () => {
    __setLimitsFlagsForTest({ p1: true, p2: true, p2FeeCharged: true, p3: true });
    const params = wizardParams({ p3: true, tokenPriceE6: TOKEN_PRICE_E6 });
    const { outcome } = await launch(params);
    record("SIM p3-on-v22", { outcome, simulated: simulated.length, results: simResults, wireBytes: simulated[0]?.length });
    expect(simulated.length).toBeGreaterThan(0);
    expect(simResults[0]?.err ?? null).toBeNull();
  }, 120_000);

  it("LIMITS_P3 unset + V22 target: simulateTransaction of the batch's first transaction (createAccount slab + ATA + InitMarket + SetNftProgramId)", async () => {
    __setLimitsFlagsForTest(null);
    const params = wizardParams({ p3: false, tokenPriceE6: TOKEN_PRICE_E6 });
    captureBatches();
    await launch(params);
    const tx = batches[0]![0]!;
    tx.feePayer = WALLET.publicKey;
    const bh = await DEVNET!.getLatestBlockhash("confirmed");
    tx.recentBlockhash = bh.blockhash;
    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const res = await realFetch("https://api.devnet.solana.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [Buffer.from(wire).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }] }),
    });
    const j = (await res.json()) as { result?: { value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }; error?: unknown };
    record("SIM p3-unset-v22-m1", { wireBytes: wire.length, result: j.result?.value ?? j.error });
    expect(j.result).toBeDefined();
    expect(j.result!.value.err ?? null).toBeNull();
  }, 120_000);
});
