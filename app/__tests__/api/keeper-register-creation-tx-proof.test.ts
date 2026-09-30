// @vitest-environment node
/**
 * UX WP-7 AC3 at the ROUTE (SECURITY REVIEW REQUIRED before merge): POST
 * /api/playground/keeper-register authenticates with the market-creation transaction (proofTx),
 * not a signed message. Driving the real handler with a mocked devnet connection:
 *  - no proofTx -> 400; a signed-message body (deployer + signature, the removed H1v2 path) is
 *    NOT accepted any more -> 400;
 *  - the creator's M1 with the matching memo -> passes auth (reaches the pool classification);
 *  - a stranger's memo tx, a memo for another pool, a missing tx -> refused (403 / 409), no write.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

const prevNetwork = process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
afterAll(() => {
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = prevNetwork;
});

const h = vi.hoisted(() => ({ tx: null as unknown, programId: "", slabOwner: "", juniorOwner: null as string | null }));
const blobPut = vi.fn(async () => ({ url: "https://blob.invalid/x" }));

vi.mock("@vercel/blob", () => ({ put: blobPut, list: vi.fn(async () => ({ blobs: [] })), head: vi.fn(async () => null), del: vi.fn(async () => undefined) }));
vi.mock("@lib/supabase", () => ({}));
vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => ({ from: () => ({ upsert: vi.fn(async () => ({ error: null })), select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<object>()), getAllProgramIds: () => [h.programId] }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getAccountInfo: async (pk: PublicKey) => (pk.toBase58() === SLAB_KP.publicKey.toBase58() ? { owner: new PublicKey(h.programId), data: Buffer.alloc(8) } : null),
    getTransaction: async () => h.tx,
  }),
}));
// Past auth the route classifies the pool on mainnet: stop there, deterministically.
vi.mock("@/lib/dex-pool-owner", async (orig) => ({ ...(await orig<object>()), classifyPoolsByOwner: vi.fn(async () => new Map()) }));

const { buildM1Instructions } = await import("@/lib/create-market-m1");
const { buildBatchTx } = await import("@/lib/tx");
const { buildKeeperRegisterMemoIx, keeperMemoParams } = await import("@/lib/keeper-register-memo");
const { buildV17InitMarketArgs } = await import("@/lib/create-market-args");
const { deriveMarketParams } = await import("@/lib/market-params");
const { POST } = await import("@/app/api/playground/keeper-register/route");

const SLAB_KP = Keypair.generate();
const CREATOR = Keypair.generate();
const POOL = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const REQ = { slabAddress: SLAB_KP.publicKey.toBase58(), dexPoolAddress: POOL, mainnetCA: null, dexType: "meteora-dlmm", symbol: "TEST" };

function landed(tx: Transaction) {
  const msg = tx.compileMessage();
  return {
    meta: { err: null },
    transaction: {
      message: {
        staticAccountKeys: msg.accountKeys,
        header: msg.header,
        compiledInstructions: msg.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accountKeyIndexes: ix.accounts, data: Buffer.from(bs58.decode(ix.data)) })),
      },
    },
  };
}

async function creatorM1(pool = POOL, signer = CREATOR) {
  const derived = deriveMarketParams(5, 1_000_000_000n, 1_000_000n);
  const k = () => Keypair.generate().publicKey;
  const ixs = buildM1Instructions({
    programId: new PublicKey(h.programId), wallet: signer.publicKey, slab: SLAB_KP.publicKey, mint: k(), vaultAta: k(), vaultPda: k(), nftRegistry: k(),
    slabRent: 1, slabSize: 3675, initArgs: buildV17InitMarketArgs({ initialPriceE6: 1_000_000n, tradingFeeBps: 30 }, derived),
    memo: await buildKeeperRegisterMemoIx(signer.publicKey, keeperMemoParams({ ...REQ, dexPoolAddress: pool })),
  });
  const tx = buildBatchTx({ instructions: ixs, computeUnits: 400_000, priorityFeeMicroLamports: 1, blockhash: "11111111111111111111111111111111", feePayer: signer.publicKey });
  tx.sign(signer, SLAB_KP);
  return tx;
}

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest("http://localhost/api/playground/keeper-register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...REQ, ...body }) }));

describe("keeper-register authenticates with the creation transaction", () => {
  beforeEach(() => {
    h.programId = Keypair.generate().publicKey.toBase58();
    h.tx = null;
    blobPut.mockClear();
  });

  it("no proofTx -> 400; the removed signed-message body is not accepted", async () => {
    expect((await post({})).status).toBe(400);
    const r = await post({ deployer: CREATOR.publicKey.toBase58(), signature: Buffer.alloc(64, 7).toString("base64") });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/proofTx/);
    expect(blobPut).not.toHaveBeenCalled();
  });

  it("the creator's M1 with the matching memo passes auth (the route moves on to the pool check)", async () => {
    h.tx = landed(await creatorM1());
    const r = await post({ proofTx: "sig" });
    const body = (await r.json()) as { error?: string };
    expect([401, 403, 409]).not.toContain(r.status);
    expect(body.error ?? "").not.toMatch(/proof|proofTx/i);
  });

  it("NEGATIVE: a memo for another pool (repointing) -> 403, nothing written", async () => {
    h.tx = landed(await creatorM1(Keypair.generate().publicKey.toBase58()));
    const r = await post({ proofTx: "sig" });
    expect(r.status).toBe(403);
    expect(blobPut).not.toHaveBeenCalled();
  });

  it("NEGATIVE: a stranger's memo tx (no InitMarket, not the junior owner) -> 403", async () => {
    const stranger = Keypair.generate();
    const tx = new Transaction({ feePayer: stranger.publicKey, recentBlockhash: "11111111111111111111111111111111" }).add(
      await buildKeeperRegisterMemoIx(stranger.publicKey, keeperMemoParams(REQ)),
    );
    tx.sign(stranger);
    h.tx = landed(tx);
    expect((await post({ proofTx: "sig" })).status).toBe(403);
    expect(blobPut).not.toHaveBeenCalled();
  });

  it("not landed yet -> 409 (the client's backoff retries it)", async () => {
    h.tx = null;
    expect((await post({ proofTx: "sig" })).status).toBe(409);
  });
});
