/**
 * GH#2600 — /api/auto-fund must give back the caller's 24h faucet claim when a
 * THROW (not just the existing "nothing funded" return) leaves it funding nothing.
 *
 * `tryFaucetGate` is check-AND-reserve. The only release site used to be the
 * "nothing funded" branch at the end of the handler, reached after both the SOL
 * airdrop and USDC mint attempts had already run their own internal try/catch and
 * failed quietly. But `connection.getBalance(walletPk)` — a bare RPC call — runs
 * BEFORE either of those, unwrapped: a throw there (RPC hiccup, timeout, etc.)
 * fell straight to the function's outer catch, which returned 500 "Internal
 * server error" without ever releasing the claim. Every retry for 24 hours then
 * answered 429, for an error the caller cannot see or fix.
 *
 * SIBLING OF #2597/#2601 (devnet-pre-fund) and the exact gap #2521 left on THIS
 * route: #2521 fixed auto-fund's RETURN paths; this closes its THROW path.
 *
 * This drives the real handler, so it asserts behaviour rather than source text.
 */
// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getBalance: vi.fn(),
  getTokenAccountBalance: vi.fn(),
  getLatestBlockhash: vi.fn(),
  sendRawTransaction: vi.fn(),
  confirmTransaction: vi.fn(),

  getAssociatedTokenAddress: vi.fn(),
  getDevnetMintSigner: vi.fn(),

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
  }
  class Transaction {
    instructions: unknown[] = [];
    add(...ix: unknown[]) { this.instructions.push(...ix); return this; }
    serialize(): Buffer { return Buffer.from([]); }
  }
  // The PUBLIC devnet Connection (used only for the best-effort SOL airdrop).
  // Deliberately has no requestAirdrop/confirmTransaction — calling either throws,
  // which the airdrop's own internal try/catch swallows as non-fatal. Isolated
  // from the SERVER connection (mocked separately below via "@/lib/server-rpc")
  // so a getBalance()-throws test can't be confused with a public-RPC failure.
  class Connection {}
  return { Connection, PublicKey, Transaction, LAMPORTS_PER_SOL: 1_000_000_000 };
});

vi.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddress: mocks.getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction: vi.fn(),
  createMintToInstruction: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    rpcUrl: "https://api.devnet.solana.com",
    testUsdcMint: "So11111111111111111111111111111111111111112",
  }),
}));

vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getBalance: mocks.getBalance,
    getTokenAccountBalance: mocks.getTokenAccountBalance,
    getLatestBlockhash: mocks.getLatestBlockhash,
    sendRawTransaction: mocks.sendRawTransaction,
    confirmTransaction: mocks.confirmTransaction,
  }),
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
  return new NextRequest("http://localhost/api/auto-fund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: "11111111111111111111111111111111" }),
  });
}

let POST: typeof import("@/app/api/auto-fund/route").POST;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;

  // The gate ALLOWS and hands back a claimId — i.e. the claim is now reserved.
  mocks.tryFaucetGate.mockResolvedValue({ allowed: true, nextClaimAt: null, claimId: 4242 });
  mocks.releaseFaucetClaim.mockResolvedValue(undefined);
  mocks.analyticsInsert.mockResolvedValue({ error: null });
  mocks.analyticsFrom.mockReturnValue({ insert: mocks.analyticsInsert });

  mocks.getAssociatedTokenAddress.mockResolvedValue({
    toBase58: () => "11111111111111111111111111111111",
  });
  mocks.getTokenAccountBalance.mockResolvedValue({ value: { uiAmount: 0 } });
  mocks.getLatestBlockhash.mockResolvedValue({ blockhash: "bh", lastValidBlockHeight: 1 });
  mocks.sendRawTransaction.mockResolvedValue("sig");
  mocks.confirmTransaction.mockResolvedValue({ context: { slot: 1 }, value: { err: null } });
  mocks.getDevnetMintSigner.mockReturnValue({
    publicKey: () => "11111111111111111111111111111111",
    signTransaction: (tx: unknown) => tx,
  });

  // Default: enough SOL, so the airdrop branch is skipped and the USDC branch
  // decides the outcome — kept overridable per-test.
  mocks.getBalance.mockResolvedValue(1_000_000_000);

  const route = await import("@/app/api/auto-fund/route");
  POST = route.POST;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
});

describe("GH#2600: /api/auto-fund releases the claim on a THROW, not just a return", () => {
  it("releases the claim when connection.getBalance() throws before either fund attempt runs", async () => {
    mocks.getBalance.mockRejectedValue(new Error("RPC timeout"));

    const res = await POST(createRequest());

    expect(res.status).toBe(500);
    expect(mocks.tryFaucetGate).toHaveBeenCalledTimes(1);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalledWith(expect.anything(), 4242);
    expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("still releases on the pre-existing 'nothing funded' path (regression guard)", async () => {
    // Both attempts run and both fail internally — the ORIGINAL release site.
    mocks.getBalance.mockResolvedValue(0); // triggers the airdrop attempt
    // requestAirdrop isn't mocked on the Connection class here, so calling it
    // throws inside the airdrop's own try/catch (non-fatal, swallowed).
    mocks.getTokenAccountBalance.mockRejectedValue(new Error("ATA missing"));
    mocks.sendRawTransaction.mockRejectedValue(new Error("mint failed"));

    const res = await POST(createRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.funded).toBe(false);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalledWith(expect.anything(), 4242);
  });

  it("CONTROL: successful funding keeps the claim (no release)", async () => {
    const res = await POST(createRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.funded).toBe(true);
    expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
  });

  it("CONTROL: a rate-limited wallet reserves nothing to leak", async () => {
    mocks.tryFaucetGate.mockResolvedValue({ allowed: false, nextClaimAt: "2026-01-01T00:00:00Z" });

    const res = await POST(createRequest());

    expect(res.status).toBe(429);
    expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
    expect(mocks.getBalance).not.toHaveBeenCalled();
  });

  it("the release is best-effort — a cleanup failure does not crash the response", async () => {
    mocks.getBalance.mockRejectedValue(new Error("RPC timeout"));
    mocks.releaseFaucetClaim.mockRejectedValue(new Error("supabase unavailable"));

    const res = await POST(createRequest());

    expect(res.status).toBe(500);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalledTimes(1);
  });
});
