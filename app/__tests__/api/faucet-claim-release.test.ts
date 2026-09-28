/**
 * GH#2600 — /api/faucet must give back the caller's 24h faucet claim when a THROW
 * on the USDC path (not just its already-covered RETURN paths) leaves it funding
 * nothing.
 *
 * `tryFaucetGate` is check-AND-reserve. Every RETURN in the USDC mint path already
 * releases (a manual `if (supabase && gate.claimId) { ... }` before each one), and
 * the tx build/send/confirm try/catch releases then rethrows. But four statements
 * between the gate and that try/catch are unwrapped: getConfig(),
 * `new PublicKey(usdcMintAddr)`, `new PublicKey(mintSigner.publicKey())`, and
 * getServerConnection() — a THROW from any of them fell straight to the function's
 * outer catch, which never released. Same defect class as #2597.
 *
 * This drives the real handler, so it asserts behaviour rather than source text.
 */
// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  confirmTransaction: vi.fn(),
  getAccountInfo: vi.fn(),
  getLatestBlockhash: vi.fn(),
  sendRawTransaction: vi.fn(),
  getSignatureStatus: vi.fn(),

  getAssociatedTokenAddress: vi.fn(),
  getAccount: vi.fn(),

  getDevnetMintSigner: vi.fn(),
  getConfig: vi.fn(),
  getServerConnection: vi.fn(),

  tryFaucetGate: vi.fn(),
  releaseFaucetClaim: vi.fn(),

  analyticsInsert: vi.fn(),
  analyticsFrom: vi.fn(),

  captureException: vi.fn(),
}));

vi.mock("@solana/web3.js", () => {
  class PublicKey {
    constructor(private readonly value: unknown) {}
    toBase58(): string {
      return typeof this.value === "string" ? this.value : "11111111111111111111111111111111";
    }
    equals(other: { toBase58?: () => string }): boolean {
      return other?.toBase58?.() === this.toBase58();
    }
  }
  class Transaction {
    instructions: unknown[] = [];
    add(...ix: unknown[]) { this.instructions.push(...ix); return this; }
    serialize(): Buffer { return Buffer.from([]); }
  }
  class Connection {}
  return { Connection, PublicKey, Transaction, LAMPORTS_PER_SOL: 1_000_000_000 };
});

vi.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddress: mocks.getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction: vi.fn(),
  createMintToInstruction: vi.fn(),
  getAccount: mocks.getAccount,
}));

vi.mock("@/lib/config", () => ({
  getConfig: (...a: unknown[]) => mocks.getConfig(...a),
}));

vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: (...a: unknown[]) => mocks.getServerConnection(...a),
}));

vi.mock("@/lib/devnet-signer", () => ({
  getDevnetMintSigner: mocks.getDevnetMintSigner,
}));

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => ({ from: mocks.analyticsFrom }),
}));

vi.mock("@/lib/faucet-rate-gate", () => ({
  tryFaucetGate: mocks.tryFaucetGate,
  releaseFaucetClaim: mocks.releaseFaucetClaim,
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.captureException,
}));

function createRequest(): NextRequest {
  return new NextRequest("http://localhost/api/faucet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: "11111111111111111111111111111111", type: "usdc" }),
  });
}

let POST: typeof import("@/app/api/faucet/route").POST;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;

  mocks.tryFaucetGate.mockResolvedValue({ allowed: true, nextClaimAt: null, claimId: 88 });
  mocks.releaseFaucetClaim.mockResolvedValue(undefined);
  mocks.analyticsInsert.mockResolvedValue({ error: null });
  mocks.analyticsFrom.mockReturnValue({ insert: mocks.analyticsInsert });

  mocks.getConfig.mockReturnValue({
    rpcUrl: "https://api.devnet.solana.com",
    testUsdcMint: "So11111111111111111111111111111111111111112",
  });
  mocks.getServerConnection.mockReturnValue({
    confirmTransaction: mocks.confirmTransaction,
    getAccountInfo: mocks.getAccountInfo,
    getLatestBlockhash: mocks.getLatestBlockhash,
    sendRawTransaction: mocks.sendRawTransaction,
    getSignatureStatus: mocks.getSignatureStatus,
  });

  mocks.getAssociatedTokenAddress.mockResolvedValue({
    toBase58: () => "11111111111111111111111111111111",
  });
  mocks.getAccount.mockResolvedValue({});
  mocks.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(0) });
  mocks.getLatestBlockhash.mockResolvedValue({ blockhash: "bh", lastValidBlockHeight: 1 });
  mocks.sendRawTransaction.mockResolvedValue("sig");
  mocks.confirmTransaction.mockResolvedValue({ context: { slot: 1 }, value: { err: null } });
  mocks.getDevnetMintSigner.mockReturnValue({
    publicKey: () => "11111111111111111111111111111111",
    signTransaction: (tx: unknown) => tx,
  });

  const route = await import("@/app/api/faucet/route");
  POST = route.POST;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
});

describe("GH#2600: /api/faucet releases the claim on a THROW between the gate and the USDC tx try/catch", () => {
  it("releases the claim when getConfig() throws (server misconfiguration)", async () => {
    mocks.getConfig.mockImplementation(() => {
      throw new Error("config blew up");
    });

    const res = await POST(createRequest());

    expect(res.status).toBe(500);
    expect(mocks.tryFaucetGate).toHaveBeenCalledTimes(1);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalledWith(expect.anything(), 88);
    expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("releases the claim when getServerConnection() throws", async () => {
    mocks.getServerConnection.mockImplementation(() => {
      throw new Error("no working devnet RPC configured");
    });

    const res = await POST(createRequest());

    expect(res.status).toBe(500);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalledWith(expect.anything(), 88);
  });

  it("existing manual release paths still work (regression guard): missing signer", async () => {
    mocks.getDevnetMintSigner.mockReturnValue(null);

    const res = await POST(createRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toMatch(/not configured for token minting/i);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalledWith(expect.anything(), 88);
  });

  it("CONTROL: a successful USDC mint keeps the claim (no release)", async () => {
    const res = await POST(createRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.usdc_minted).toBe(true);
    expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
  });

  it("CONTROL: a rate-limited wallet reserves nothing to leak", async () => {
    mocks.tryFaucetGate.mockResolvedValue({ allowed: false, nextClaimAt: "2026-01-01T00:00:00Z" });

    const res = await POST(createRequest());

    expect(res.status).toBe(429);
    expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
    expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("the release is best-effort — a cleanup failure does not crash the response", async () => {
    mocks.getConfig.mockImplementation(() => {
      throw new Error("config blew up");
    });
    mocks.releaseFaucetClaim.mockRejectedValue(new Error("supabase unavailable"));

    const res = await POST(createRequest());

    expect(res.status).toBe(500);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalledTimes(1);
  });
});
