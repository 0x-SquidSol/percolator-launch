// @vitest-environment node
// (the SDK's buffer-layout encoders reject jsdom's realm-separated Uint8Array)
/**
 * keeper-cosign for a market that doesn't exist yet (the one-approval launch).
 *
 * attemptFreshBatchedLaunch requests the keeper co-sign BEFORE M1 (createAccount
 * + InitMarket + SetNftProgramId) is even signed, because the co-sign tx is part
 * of the single approval. The route used to read the (missing) slab and return
 * 404 "market account not found", so every launch fell back to six approvals —
 * surfaced to users by the #2587 fallback-reason note as
 * "Keeper co-sign failed (404): market account not found".
 *
 * With `fresh: true` and no slab yet, the route builds the co-sign tx from asset
 * 0's post-M1 values (marketId 1, oracleObservation 0, authorityEpoch 0).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { encodeConfigureAuthMark, encodeUpdateAssetAuthority, ASSET_AUTH_KIND } from "@percolatorct/sdk";

const state = vi.hoisted(() => ({
  keeper: null as import("@solana/web3.js").Keypair | null,
  partialSign: vi.fn(),
  liveMarketId: 7n,
  liveSeqs: { oracleObservation: 4n, authorityEpoch: 3n },
}));

vi.mock("@/lib/config", () => ({
  getRpcEndpoint: vi.fn(() => "http://127.0.0.1:8899"),
  getNetwork: vi.fn(() => "devnet"), // getServerConnection() picks the cluster with it
  getConfig: vi.fn(() => ({ programId: "11111111111111111111111111111111" })),
}));

vi.mock("@/lib/playground-keeper-signer", () => ({
  requirePlaygroundKeeperSigner: () => {
    if (!state.keeper) throw new Error("Test keeper was not initialized");
    return { publicKey: () => state.keeper!.publicKey.toBase58(), partialSign: state.partialSign };
  },
}));

// Controlled "live state" for the existing-slab case.
vi.mock("@/lib/v18-wire", () => ({
  readAssetMarketId: vi.fn(() => state.liveMarketId),
  readAssetControlSeqs: vi.fn(() => state.liveSeqs),
}));

const NOW_SLOT = 123456;
const PRICE_E6 = 1_000_000n;
const originalDefaultNetwork = process.env.NEXT_PUBLIC_DEFAULT_NETWORK;

let POST: (request: NextRequest) => Promise<Response>;
let readers: typeof import("@/lib/v18-wire");

function cosignRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/playground/keeper-cosign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deployer: Keypair.generate().publicKey.toBase58(),
      slabAddress: Keypair.generate().publicKey.toBase58(),
      initialPriceE6: PRICE_E6.toString(),
      assetIndex: 0,
      ...body,
    }),
  });
}

async function decodeTx(res: Response): Promise<Transaction> {
  const { partialTxBase64 } = (await res.json()) as { partialTxBase64: string };
  return Transaction.from(Buffer.from(partialTxBase64, "base64"));
}

function expectedIxData(marketId: bigint, observationSequence: bigint, authorityEpoch: bigint) {
  return {
    configure: Buffer.from(
      encodeConfigureAuthMark({
        assetIndex: 0,
        marketId,
        nowSlot: BigInt(NOW_SLOT),
        initialMarkE6: PRICE_E6,
        observationSequence,
      }),
    ),
    delegate: Buffer.from(
      encodeUpdateAssetAuthority({
        assetIndex: 0,
        marketId,
        kind: ASSET_AUTH_KIND.Oracle,
        newPubkey: new PublicKey(state.keeper!.publicKey),
        authorityEpoch,
      }),
    ),
  };
}

describe("keeper-cosign — fresh market (one-approval launch)", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    vi.spyOn(Connection.prototype, "getSlot");
    vi.spyOn(Connection.prototype, "getLatestBlockhash");
    vi.spyOn(Connection.prototype, "getAccountInfo");
    ({ POST } = await import("@/app/api/playground/keeper-cosign/route"));
    readers = await import("@/lib/v18-wire");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.keeper = Keypair.generate();
    state.partialSign.mockImplementation((tx: Transaction) => tx.partialSign(state.keeper!));
    vi.mocked(Connection.prototype.getSlot).mockResolvedValue(NOW_SLOT);
    vi.mocked(Connection.prototype.getLatestBlockhash).mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 999_999,
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
    if (originalDefaultNetwork === undefined) delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
    else process.env.NEXT_PUBLIC_DEFAULT_NETWORK = originalDefaultNetwork;
  });

  it("co-signs a not-yet-created market with asset 0's post-M1 values instead of returning 404", async () => {
    vi.mocked(Connection.prototype.getAccountInfo).mockResolvedValue(null);

    const res = await POST(cosignRequest({ fresh: true }));

    expect(res.status).toBe(200);
    const tx = await decodeTx(res);
    const want = expectedIxData(1n, 1n, 0n); // marketId 1, observation 0+1, epoch 0
    expect(Buffer.from(tx.instructions[0].data)).toEqual(want.configure);
    expect(Buffer.from(tx.instructions[1].data)).toEqual(want.delegate);
    // No slab to read — the live-state readers must not have been consulted.
    expect(readers.readAssetMarketId).not.toHaveBeenCalled();
    expect(readers.readAssetControlSeqs).not.toHaveBeenCalled();
  });

  it("without `fresh`, a missing market is still 404 (the per-step path is unchanged)", async () => {
    vi.mocked(Connection.prototype.getAccountInfo).mockResolvedValue(null);

    const res = await POST(cosignRequest({}));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "market account not found" });
  });

  it("rejects `fresh` for any asset but 0 (only asset 0 exists after InitMarket)", async () => {
    vi.mocked(Connection.prototype.getAccountInfo).mockResolvedValue(null);

    const res = await POST(cosignRequest({ fresh: true, assetIndex: 1 }));

    expect(res.status).toBe(400);
    expect(state.partialSign).not.toHaveBeenCalled();
  });

  it("an EXISTING market always binds to its live state, even when `fresh` is sent", async () => {
    vi.mocked(Connection.prototype.getAccountInfo).mockResolvedValue({
      data: Buffer.alloc(64),
      executable: false,
      lamports: 1,
      owner: new PublicKey("11111111111111111111111111111111"),
      rentEpoch: 0,
    });

    const res = await POST(cosignRequest({ fresh: true }));

    expect(res.status).toBe(200);
    const tx = await decodeTx(res);
    const want = expectedIxData(7n, 5n, 3n); // live: marketId 7, observation 4+1, epoch 3
    expect(Buffer.from(tx.instructions[0].data)).toEqual(want.configure);
    expect(Buffer.from(tx.instructions[1].data)).toEqual(want.delegate);
  });
});
