/**
 * GH#2707: the portfolio scan store must distinguish "not scanned yet" from
 * "scanned, this wallet has no account". Before the fix both read as
 * `getPortfolioUserAccountSnapshot(key) === null`, so every trade surface
 * showed a funded trader a zero balance / no-account CTA while the first scan
 * was in flight (30 s+ under 429 backoff).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({ parsePortfolioV17: vi.fn() }));
vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return { ...actual, parsePortfolioV17: mocks.parsePortfolioV17 };
});

import {
  makePortfolioScanKey,
  triggerPortfolioScan,
  getPortfolioUserAccountSnapshot,
  getPortfolioScanResolved,
  subscribePortfolioScan,
} from "@/lib/userAccountScan";

let n = 100;
const uniquePubkey = () => new PublicKey(new Uint8Array(32).fill(++n % 256));

let programId: PublicKey;
let wallet: PublicKey;
let slabAddress: string;

beforeEach(() => {
  vi.clearAllMocks();
  programId = uniquePubkey();
  wallet = uniquePubkey();
  slabAddress = uniquePubkey().toBase58();
});

function makeConnection() {
  const getProgramAccounts = vi.fn();
  return { connection: { getProgramAccounts } as unknown as Connection, getProgramAccounts };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("userAccountScan — scan resolution status (GH#2707)", () => {
  it("a null key has nothing to scan and reads resolved", () => {
    expect(getPortfolioScanResolved(null)).toBe(true);
  });

  it("is unresolved for a key never scanned, and while the first scan is in flight", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    const d = deferred<unknown[]>();
    getProgramAccounts.mockReturnValue(d.promise);
    const key = makePortfolioScanKey(programId, slabAddress, wallet);

    expect(getPortfolioScanResolved(key)).toBe(false);
    const p = triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    expect(getPortfolioScanResolved(key)).toBe(false);
    expect(getPortfolioUserAccountSnapshot(key)).toBeNull(); // same null as "no account" — hence the flag

    d.resolve([]);
    await p;
    expect(getPortfolioScanResolved(key)).toBe(true);
  });

  it("notifies subscribers when the first scan resolves to 'no account' (null → null is still a state change)", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([]);
    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    const listener = vi.fn();
    subscribePortfolioScan(key, listener);

    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPortfolioScanResolved(key)).toBe(true);
    expect(getPortfolioUserAccountSnapshot(key)).toBeNull();

    // A later identical "no account" scan still bails out (no re-render storm).
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([2]) });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stays unresolved when the first scan fails (a 429 is not proof of 'no account')", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const key = makePortfolioScanKey(programId, slabAddress, wallet);

    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    expect(getPortfolioScanResolved(key)).toBe(false);
  });

  it("a failed scan does not pin the dedup claim: re-triggering the SAME raw retries", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockRejectedValueOnce(new Error("429 Too Many Requests")).mockResolvedValueOnce([]);
    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    const raw = new Uint8Array([7]);

    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw });
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw });
    expect(getProgramAccounts).toHaveBeenCalledTimes(2);
    expect(getPortfolioScanResolved(key)).toBe(true);
  });

  it("stays resolved (keep-last-good) when a later scan fails", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("timeout"));
    const key = makePortfolioScanKey(programId, slabAddress, wallet);

    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([2]) });
    expect(getPortfolioScanResolved(key)).toBe(true);
  });
});
