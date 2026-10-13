// @vitest-environment node
/**
 * v2.2 QA RT5-2 (retest 6): Solflare rejects an EXPIRED popup (~70 s) with JsonRpcError "Transaction cancelled", the
 * same text as a decline. Classified by elapsed time: lib/v22/sign-guard.ts WALLET_EXPIRY_MIN_MS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, Transaction, TransactionInstruction, PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_GENESIS_HASH } from "@/lib/v22/devnet-guard";
import { __resetSignGuardForTest, guardSign, noteBlockhash, WalletRequestClosedError, WALLET_EXPIRY_MIN_MS, isSignDebugEnabled, signLog } from "@/lib/v22/sign-guard";
import { resolveUserMessage } from "@/lib/limits/user-message";

const BH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const payer = Keypair.generate();
const conn = { getGenesisHash: vi.fn(async () => DEVNET_GENESIS_HASH), isBlockhashValid: vi.fn(async () => ({ context: { slot: 1 }, value: true })) };
function tx(): Transaction {
  const t = new Transaction();
  t.add(new TransactionInstruction({ programId: new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM"), keys: [], data: Buffer.from([10]) }));
  t.recentBlockhash = BH;
  t.feePayer = payer.publicKey;
  return t;
}
const TIMEOUT_COPY = "The wallet request timed out. Nothing was sent — try again.";
const solflareCancel = () => Object.assign(new Error("Transaction cancelled"), { name: "JsonRpcError" });

/** A wallet that rejects after `afterMs` of (fake) clock time. */
async function reject(err: Error, afterMs: number): Promise<unknown> {
  let clock = 1_000;
  noteBlockhash(BH, "sendTx attempt 1", conn, clock);
  return guardSign({
    txs: [tx()], via: "adapter signTransaction", connection: conn, chain: "solana:devnet", now: () => clock,
    sign: async () => { clock += afterMs; throw err; },
  }).catch((e) => e);
}

describe("RT5-2 expiry vs decline", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __resetSignGuardForTest(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });

  it("slow 'Transaction cancelled' (popup expired) -> timeout copy", async () => {
    for (const ms of [WALLET_EXPIRY_MIN_MS, 70_000, 90_000]) {
      const thrown = await reject(solflareCancel(), ms);
      expect(thrown).toBeInstanceOf(WalletRequestClosedError);
      expect(resolveUserMessage(thrown, {}).body).toBe(TIMEOUT_COPY);
    }
  });

  it("slow 4001 / 'User rejected' is also an expiry", async () => {
    expect(resolveUserMessage(await reject(Object.assign(new Error("x"), { code: 4001 }), 70_000), {}).body).toBe(TIMEOUT_COPY);
    expect(resolveUserMessage(await reject(new Error("User rejected the request."), 70_000), {}).body).toBe(TIMEOUT_COPY);
  });

  it("fast 'Transaction cancelled' stays a decline", async () => {
    for (const ms of [0, 2_000, WALLET_EXPIRY_MIN_MS - 1]) {
      const thrown = await reject(solflareCancel(), ms);
      expect(thrown).not.toBeInstanceOf(WalletRequestClosedError);
      expect(resolveUserMessage(thrown, {}).body).not.toBe(TIMEOUT_COPY);
      expect(resolveUserMessage(thrown, {}).body).toBe("Cancelled.");
    }
  });

  it("a slow locked wallet / expired blockhash keep their own meaning", async () => {
    const locked = new Error("Wallet is locked");
    const expired = new Error("Transaction has expired: block height exceeded");
    expect(await reject(locked, 90_000)).toBe(locked);
    expect(await reject(expired, 90_000)).toBe(expired);
  });

  it("the sign log still records the request as declined", async () => {
    await reject(solflareCancel(), 70_000);
    expect(signLog()[0]).toMatchObject({ wallet: "declined", walletError: expect.stringContaining("Transaction cancelled") });
  });

  it("debug line opt-in: off without window; helper reads ?signdebug=1 / localStorage", () => {
    expect(isSignDebugEnabled()).toBe(false);
    const store = new Map<string, string>();
    const win = { location: { search: "" }, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
    vi.stubGlobal("window", win);
    try {
      expect(isSignDebugEnabled()).toBe(false);
      win.location.search = "?signdebug=1";
      expect(isSignDebugEnabled()).toBe(true);
      win.location.search = "";
      expect(isSignDebugEnabled()).toBe(true); // remembered
      win.location.search = "?signdebug=0";
      expect(isSignDebugEnabled()).toBe(false);
      win.location.search = "";
      expect(isSignDebugEnabled()).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});
