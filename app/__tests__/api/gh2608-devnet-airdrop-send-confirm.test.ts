/**
 * #2608: POST /api/devnet-airdrop returned a bare 500 "Internal server error"
 * on every launch — the real exception only reached Sentry.
 *
 * Root cause: the route built its blockhash from getServerConnection's default
 * "confirmed" commitment, then called sendRawTransaction (preflight ON) followed
 * by confirmTransaction(sig, "confirmed"). On the load-balanced padre devnet RPC,
 * a "confirmed" blockhash may not have propagated to whichever node handles the
 * preflight simulation yet ("Blockhash not found"), and confirmTransaction()
 * separately throws TransactionExpiredBlockheightExceededError on a
 * slow-but-landed tx. Both were uncaught and became the outer catch's bare 500 —
 * on every launch, since a mint attempt is the only thing the success path does.
 *
 * Fix (mirrors lib/server-rpc.ts::sendAndConfirmServerTx, built for the identical
 * bug in /api/devnet-pre-fund): fetch a FINALIZED blockhash, skip preflight
 * (trusted, already-signed server tx), and confirm by POLLING getSignatureStatus
 * instead of confirmTransaction(). The outer catch now also surfaces the real
 * error message instead of a fixed string.
 *
 * This drives the REAL route handler (not a logic simulation) with a fake
 * connection so the actual send/confirm code path — including the new
 * sendAndConfirmSignedTx helper and the real sealed-signer (lib/devnet-signer.ts)
 * — is what's under test. @solana/web3.js is mocked (like
 * faucet-confirmation-result.test.ts does for the same route family): a real
 * Transaction's signature-verifying serialize() crashes under this repo's
 * jsdom test environment (`TypeError: b must be a Uint8Array` from
 * @solana/buffer-layout, reproduced even with zero mocking involved — a
 * pre-existing environment limitation, not a route bug), so this route family
 * always tests through a lightweight fake instead of real ed25519/serialization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@solana/web3.js", () => {
  /**
   * Minimal PublicKey: stores either a plain label string, or recovers one
   * from a 32-byte null-padded buffer (mirrors how buildMintAccountData below
   * embeds an authority label into an account-data byte range, so the route's
   * `new PublicKey(mintData.slice(4, 36))` round-trips back to a comparable
   * value without needing real base58/ed25519).
   */
  class PublicKey {
    private readonly raw: string;
    constructor(value: string | Uint8Array | Buffer) {
      this.raw =
        typeof value === "string"
          ? value
          : Buffer.from(value).toString("utf-8").replace(/\0+$/, "");
    }
    toBase58(): string {
      return this.raw;
    }
    toBytes(): Uint8Array {
      return Buffer.alloc(32);
    }
    toBuffer(): Buffer {
      const buf = Buffer.alloc(32);
      Buffer.from(this.raw, "utf-8").copy(buf);
      return buf;
    }
    equals(other: { toBase58?: () => string }): boolean {
      return other?.toBase58?.() === this.raw;
    }
    static isOnCurve(): boolean {
      return true;
    }
  }

  class Transaction {
    recentBlockhash?: string;
    feePayer?: PublicKey;
    instructions: unknown[] = [];
    add(...ix: unknown[]): this {
      this.instructions.push(...ix);
      return this;
    }
    partialSign(): this {
      return this;
    }
    serialize(): Buffer {
      return Buffer.from("fake-serialized-tx");
    }
  }

  // Distinct class so `tx instanceof VersionedTransaction` in
  // lib/devnet-signer.ts cleanly evaluates false for our Transaction instances.
  class VersionedTransaction {}

  class Keypair {
    publicKey: PublicKey;
    secretKey: Uint8Array;
    constructor(publicKey: PublicKey, secretKey: Uint8Array) {
      this.publicKey = publicKey;
      this.secretKey = secretKey;
    }
    static fromSecretKey(secretKey: Uint8Array): Keypair {
      // Real Solana secret keys are 64 bytes: [seed(32) | publicKey(32)].
      // Our test secret keys embed a label string in bytes[32:64].
      return new Keypair(new PublicKey(secretKey.slice(32, 64)), secretKey);
    }
    static generate(): Keypair {
      return new Keypair(new PublicKey("GENERATED"), new Uint8Array(64));
    }
  }

  const systemProgramId = new PublicKey("SystemProgram1111111111111111111111111111");
  const SystemProgram = {
    programId: systemProgramId,
    createAccount: vi.fn(() => ({ keys: [], programId: systemProgramId, data: Buffer.alloc(0) })),
  };

  return { PublicKey, Transaction, VersionedTransaction, Keypair, SystemProgram };
});

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ rpcUrl: "https://api.devnet.solana.com" }),
}));

vi.mock("@/lib/get-client-ip", () => ({
  getClientIp: () => "127.0.0.1",
}));

vi.mock("@/lib/fund-ip-rate-limit", () => ({
  checkFundRateLimit: vi.fn(async () => ({ allowed: true, retryAfter: 0 })),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// Supabase unavailable → route falls back to the static DEVNET_ALLOWED_MINTS
// allowlist and an in-memory rate gate. Simplest path to the mint step.
vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => {
    throw new Error("supabase not configured in test");
  },
}));

vi.mock("@solana/spl-token", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  const dummyIx = () => ({ keys: [], programId: new PublicKey("TokenProgram"), data: Buffer.alloc(0) });
  return {
    getAssociatedTokenAddress: vi.fn(async () => new PublicKey("ATA")),
    createAssociatedTokenAccountInstruction: vi.fn(dummyIx),
    createMintToInstruction: vi.fn(dummyIx),
    createInitializeMintInstruction: vi.fn(dummyIx),
    getAccount: vi.fn(async () => {
      throw new Error("TokenAccountNotFoundError");
    }),
    MINT_SIZE: 82,
    TOKEN_PROGRAM_ID: new PublicKey("TokenProgram"),
    getMinimumBalanceForRentExemptMint: vi.fn(async () => 1_000_000),
  };
});

// @/lib/devnet-signer is NOT mocked — the real sealed signer loads
// DEVNET_MINT_AUTHORITY_KEYPAIR from env and calls tx.partialSign(), exactly
// like production, against our mocked (but structurally faithful) Transaction.

const AUTHORITY_LABEL = "AUTHORITY";
const MINT_ADDRESS = "TEST_MINT";
const WALLET_ADDRESS = "TEST_WALLET";

/** Real secret keys are 64 bytes: [seed(32) | publicKey(32)] — embed a label. */
function makeTestSecretKey(label: string): number[] {
  const sk = new Uint8Array(64);
  Buffer.from(label, "utf-8").copy(sk, 32);
  return Array.from(sk);
}

/** Real SPL Token mint account layout: u32 coption + 32-byte authority. */
function buildMintAccountData(authorityLabel: string): Buffer {
  const buf = Buffer.alloc(82, 0);
  buf.writeUInt32LE(1, 0); // coption = Some
  Buffer.from(authorityLabel, "utf-8").copy(buf, 4);
  return buf;
}

const fakeConnection = {
  getAccountInfo: vi.fn(async () => ({ data: buildMintAccountData(AUTHORITY_LABEL) })),
  getLatestBlockhash: vi.fn(async () => ({ blockhash: "FAKE_BLOCKHASH", lastValidBlockHeight: 1000 })),
  sendRawTransaction: vi.fn(async () => "fake-mint-signature"),
  getSignatureStatus: vi.fn(async () => ({ value: { err: null, confirmationStatus: "confirmed" } })),
};

vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => fakeConnection,
}));

let POST: typeof import("@/app/api/devnet-airdrop/route").POST;

function createRequest(): NextRequest {
  return new NextRequest("http://localhost/api/devnet-airdrop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mintAddress: MINT_ADDRESS, walletAddress: WALLET_ADDRESS }),
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  process.env.DEVNET_ALLOWED_MINTS = MINT_ADDRESS;
  process.env.DEVNET_MINT_AUTHORITY_KEYPAIR = JSON.stringify(makeTestSecretKey(AUTHORITY_LABEL));

  fakeConnection.getAccountInfo.mockImplementation(async () => ({
    data: buildMintAccountData(AUTHORITY_LABEL),
  }));
  fakeConnection.getLatestBlockhash.mockImplementation(async () => ({
    blockhash: "FAKE_BLOCKHASH",
    lastValidBlockHeight: 1000,
  }));
  fakeConnection.sendRawTransaction.mockImplementation(async () => "fake-mint-signature");
  fakeConnection.getSignatureStatus.mockImplementation(async () => ({
    value: { err: null, confirmationStatus: "confirmed" },
  }));

  const route = await import("@/app/api/devnet-airdrop/route");
  POST = route.POST;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  delete process.env.DEVNET_ALLOWED_MINTS;
  delete process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;
});

describe("POST /api/devnet-airdrop — #2608 send/confirm fix", () => {
  it("succeeds and returns a signature on the happy path (regression guard for the rewrite)", async () => {
    const res = await POST(createRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.signature).toBe("fake-mint-signature");
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("fetches a FINALIZED blockhash, not the connection's default commitment", async () => {
    // Root cause: a "confirmed" blockhash (what a bare getLatestBlockhash() call
    // returns on this route's "confirmed"-commitment connection) can be unknown
    // to the RPC node that handles preflight on a load-balanced endpoint.
    await POST(createRequest());
    expect(fakeConnection.getLatestBlockhash).toHaveBeenCalledWith("finalized");
  });

  it("skips preflight when broadcasting the already-signed mint tx", async () => {
    await POST(createRequest());
    const [, opts] = fakeConnection.sendRawTransaction.mock.calls[0] as [Uint8Array, { skipPreflight?: boolean }];
    expect(opts?.skipPreflight).toBe(true);
  });

  it("confirms via polling getSignatureStatus, not confirmTransaction", async () => {
    await POST(createRequest());
    expect(fakeConnection.getSignatureStatus).toHaveBeenCalled();
    expect((fakeConnection as unknown as { confirmTransaction?: unknown }).confirmTransaction).toBeUndefined();
  });

  it("surfaces the real error message on failure instead of a bare 'Internal server error' (#2608's outer-catch ask)", async () => {
    fakeConnection.sendRawTransaction.mockRejectedValueOnce(new Error("Blockhash not found"));
    const res = await POST(createRequest());
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toContain("Blockhash not found");
    expect(body.error).not.toBe("Internal server error");
  });

  it("classifies an on-chain OwnerMismatch reached via poll-based confirmation as 400, not 500", async () => {
    // sendAndConfirmSignedTx skips preflight, so this on-chain error now arrives
    // via a resolved (not thrown) signature status, not a preflight
    // SendTransactionError — isAuthorityError must match the JSON-stringified
    // on-chain error shape too.
    fakeConnection.getSignatureStatus.mockResolvedValue({
      value: { err: { InstructionError: [1, { Custom: 4 }] }, confirmationStatus: "confirmed" },
    });
    const res = await POST(createRequest());
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.hint).toBe("old_key_mirror");
  });

  it("times out with a descriptive error when the signature never confirms", async () => {
    vi.useFakeTimers();
    try {
      fakeConnection.getSignatureStatus.mockResolvedValue({ value: null });
      const resPromise = POST(createRequest());
      await vi.advanceTimersByTimeAsync(46_000);
      const res = await resPromise;
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.error).toMatch(/not confirmed within/);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});
