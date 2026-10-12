/**
 * v2.2 QA NB-2 (reopened, retest 5): instrumentation in front of EVERY wallet signature on the v2.2 build.
 *
 * One order in seven made Solflare show "Network mismatch" although the app has a single (devnet) connection. This
 * records, for every transaction handed to a wallet: where its blockhash was fetched (the path tag), how old it is,
 * what the transaction contains (program + instruction tag per instruction), and the chain the wallet was told.
 * Before the wallet opens it asserts:
 *   1. the connection the blockhash came from (else the app connection) is devnet, by genesis hash;
 *   2. the blockhash was fetched by this app from that connection. An untagged blockhash is checked on the devnet
 *      connection: unknown there = refused, known there = allowed but reported.
 * A failure refuses the signature, logs `[v22 sign-guard]` to the console and shows the debug line
 * (components/v22/SignGuardLine.tsx). Every request (also the ones the wallet declines) is kept in
 * `window.__v22SignLog`. Flag off: `guardSign` calls the wallet directly and nothing is recorded.
 *
 * QA instrumentation for the preview: remove (or put behind a debug switch) before any release.
 */
import type { Connection, Transaction } from "@solana/web3.js";
import { assertDevnetConnection, WrongClusterError } from "./devnet-guard";
import { isDevnetV22Enabled } from "./flag";
import { detectWalletError, isTransientError, UserFacingError } from "@/lib/errorMessages";
import { WALLET_REQUEST_CLOSED_COPY } from "@/lib/wallet-request-copy";
import { isWalletRejection } from "@/lib/privy-batch-sign";

export const SIGN_CHAIN_DEVNET = "solana:devnet";
/** A blockhash older than this at the moment the wallet opens is reported (not refused). */
export const STALE_BLOCKHASH_MS = 30_000;
const ORIGIN_TTL_MS = 180_000;
const LOG_MAX = 50;

type GuardConnection = Pick<Connection, "getGenesisHash" | "isBlockhashValid">;
interface Origin { path: string; ts: number; connection: GuardConnection | null }

export type SignVerdict = "ok" | "stale-blockhash" | "untagged-blockhash" | "REFUSED-wrong-cluster" | "REFUSED-blockhash-not-on-devnet";
export interface SignLogEntry {
  at: string;
  /** Which wallet call: signTransaction / signAllTransactions[i/n] and the provider. */
  via: string;
  /** Where the blockhash was fetched (the builder path). */
  path: string;
  blockhash: string;
  blockhashAgeMs: number | null;
  /** program:tag per instruction, e.g. "cb,cb,cb,w:10". */
  shape: string;
  chain: string;
  verdict: SignVerdict;
  /** What the wallet did with it. */
  wallet: "pending" | "signed" | "declined" | "not-asked";
  walletError?: string;
}

const origins = new Map<string, Origin>();
const log: SignLogEntry[] = [];
const listeners = new Set<() => void>();
let lastProblem: SignLogEntry | null = null;

/** Record where a blockhash came from. Call right after every `getLatestBlockhash` whose result is signed. */
export function noteBlockhash(blockhash: string, path: string, connection: GuardConnection | null = null, now: number = Date.now()): void {
  if (!isDevnetV22Enabled()) return;
  for (const [k, o] of origins) if (now - o.ts > ORIGIN_TTL_MS) origins.delete(k);
  origins.set(blockhash, { path, ts: now, connection });
}

const KNOWN: Record<string, string> = {
  ComputeBudget111111111111111111111111111111: "cb",
  "11111111111111111111111111111111": "sys",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "tok",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "ata",
};

/** "cb,cb,cb,w:10": the wrapper's instructions carry their tag, so the line names what was built. */
export function txShape(tx: Pick<Transaction, "instructions">, wrapperProgramId?: string): string {
  return tx.instructions
    .map((ix) => {
      const id = ix.programId.toBase58();
      if (KNOWN[id]) return KNOWN[id];
      const tag = ix.data.length > 0 ? ix.data[0] : -1;
      return `${id === wrapperProgramId ? "w" : id.slice(0, 4)}:${tag}`;
    })
    .join(",");
}

export const signLog = (): readonly SignLogEntry[] => log;
export const lastSignProblem = (): SignLogEntry | null => lastProblem;
export function subscribeSignGuard(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function dismissSignProblem(): void {
  lastProblem = null;
  listeners.forEach((f) => f());
}
/** Test seam. */
export function __resetSignGuardForTest(): void {
  origins.clear();
  log.length = 0;
  lastProblem = null;
}

export function formatSignEntry(e: SignLogEntry): string {
  const age = e.blockhashAgeMs === null ? "unknown" : `${(e.blockhashAgeMs / 1000).toFixed(1)}s`;
  return `${e.verdict} | wallet ${e.wallet} | built by ${e.path} | ${e.via} | tx ${e.shape} | blockhash ${e.blockhash.slice(0, 8)} age ${age} | chain ${e.chain} | ${e.at}`;
}

function record(e: SignLogEntry): void {
  log.push(e);
  if (log.length > LOG_MAX) log.shift();
  if (typeof window !== "undefined") (window as unknown as { __v22SignLog?: SignLogEntry[] }).__v22SignLog = log;
}
function flag(e: SignLogEntry): void {
  lastProblem = e;
  console.error(`[v22 sign-guard] ${formatSignEntry(e)}`);
  listeners.forEach((f) => f());
}

export class SignGuardError extends WrongClusterError {
  constructor(public readonly entry: SignLogEntry) {
    super(); // keeps the name "WrongClusterError": the message resolver maps it by name
  }
}

/** v2.2 QA RT5-2: the line for a wallet request that ended without a signature and without the user declining. */
export { WALLET_REQUEST_CLOSED_COPY };
/**
 * A wallet popup that expired or was closed rejects with wallet-specific text (or none), which used to fall through
 * to "Something went wrong and nothing was sent.". Nothing was signed, so nothing was sent.
 */
export class WalletRequestClosedError extends UserFacingError {
  constructor(cause: unknown) {
    super(WALLET_REQUEST_CLOSED_COPY);
    this.name = "WalletRequestClosedError";
    (this as { cause?: unknown }).cause = cause;
  }
}
/** A declined prompt, a locked wallet and the app's own explained errors keep their meaning; the rest is "closed". */
export function asWalletRequestError(err: unknown): unknown {
  if (isWalletRejection(err) || err instanceof UserFacingError) return err;
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String((err as { message?: unknown } | null)?.message ?? err);
  // Text the send loop already acts on (an expired blockhash, a rate limit) keeps its retry.
  if (detectWalletError(msg) !== null || isTransientError(msg)) return err;
  return new WalletRequestClosedError(err);
}

export interface GuardSignParams<T> {
  txs: Transaction[];
  /** "adapter signTransaction", "privy signAllTransactions", … */
  via: string;
  /** The app's connection (devnet-proven by genesis hash here). */
  connection: GuardConnection;
  /** The chain the wallet is told ("none" when the wallet API takes no chain). */
  chain: string;
  wrapperProgramId?: string;
  sign: () => Promise<T>;
  now?: () => number;
}

/** Assert, log, then let the wallet sign. See the file header. */
export async function guardSign<T>(p: GuardSignParams<T>): Promise<T> {
  if (!isDevnetV22Enabled()) return p.sign();
  const now = p.now ?? Date.now;
  const entries: SignLogEntry[] = [];
  let refused: SignLogEntry | null = null;
  for (let i = 0; i < p.txs.length; i++) {
    const tx = p.txs[i];
    const blockhash = tx.recentBlockhash ?? "";
    const origin = origins.get(blockhash) ?? null;
    const e: SignLogEntry = {
      at: new Date(now()).toISOString(),
      via: p.txs.length > 1 ? `${p.via}[${i + 1}/${p.txs.length}]` : p.via,
      path: origin?.path ?? "UNTAGGED (blockhash not fetched through a tagged path)",
      blockhash,
      blockhashAgeMs: origin ? now() - origin.ts : null,
      shape: txShape(tx, p.wrapperProgramId),
      chain: p.chain,
      verdict: "ok",
      wallet: "pending",
    };
    try {
      await assertDevnetConnection(origin?.connection ?? p.connection);
      if (origin?.connection && origin.connection !== p.connection) await assertDevnetConnection(p.connection);
    } catch {
      e.verdict = "REFUSED-wrong-cluster";
    }
    if (e.verdict === "ok" && !origin) {
      // Not fetched through a tagged path: prove it on the devnet connection. An RPC failure proves nothing.
      const known = await Promise.resolve()
        .then(() => p.connection.isBlockhashValid(blockhash, { commitment: "processed" }))
        .then((r) => r.value)
        .catch(() => null);
      e.verdict = known === false ? "REFUSED-blockhash-not-on-devnet" : "untagged-blockhash";
    } else if (e.verdict === "ok" && e.blockhashAgeMs !== null && e.blockhashAgeMs > STALE_BLOCKHASH_MS) {
      e.verdict = "stale-blockhash";
    }
    if (e.verdict.startsWith("REFUSED")) {
      e.wallet = "not-asked";
      refused ??= e;
    }
    entries.push(e);
  }
  if (refused) {
    for (const e of entries) {
      if (e.wallet === "pending") e.wallet = "not-asked";
      record(e);
    }
    flag(refused);
    throw new SignGuardError(refused);
  }
  for (const e of entries) {
    record(e);
    console.info(`[v22 sign] ${formatSignEntry(e)}`);
    if (e.verdict !== "ok") flag(e);
  }
  try {
    const out = await p.sign();
    for (const e of entries) e.wallet = "signed";
    return out;
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    for (const e of entries) {
      e.wallet = "declined";
      e.walletError = msg.slice(0, 160);
    }
    // A declined request is how a wallet-side "Network mismatch" reaches us: show which path built that transaction.
    flag(entries[0]);
    throw asWalletRequestError(err);
  }
}
