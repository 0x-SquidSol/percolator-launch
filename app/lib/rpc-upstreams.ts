/**
 * Ordered RPC upstreams with fallback, shared by the browser proxy (`/api/rpc`) and the server-side Connection helper
 * (`lib/server-rpc.ts`).
 *
 * Why: with a single upstream (`DEVNET_RPC_URL`, a Helius key) an exhausted quota (HTTP 429 / "max usage reached") made every browser
 * call answer `{"code":-32603,"message":"Upstream RPC request failed"}` and the faucet say "Could not verify mint authority due to RPC
 * error": trade, Earn and Stake were unusable.
 *
 * Rules (security review of the proxy surface):
 *  - The fallback list comes from SERVER env only (`DEVNET_RPC_FALLBACK_URLS` / `MAINNET_RPC_FALLBACK_URLS`, comma-separated; never
 *    `NEXT_PUBLIC_*`, never request input). https only. Unset on devnet = the public devnet RPC; unset on mainnet = none.
 *  - A FALLBACK must be the same cluster as the deployment: its genesis hash is checked against the cluster's, once (cached). A
 *    mismatch is never used (and is re-checked only after a long delay). The primary is the operator's own setting and is not checked.
 *  - Switch on HTTP 429 / 401 / 403 / 408 / 5xx, a "max usage" / rate-limit JSON-RPC error, a network error, a timeout or a non-JSON body.
 *    A failed upstream is cooled down (30 s, doubling to 5 min); once its cooldown ends it is tried FIRST again (the primary re-probe), and
 *    one success resets it. When every upstream is cooling they are all tried anyway, soonest-ready first.
 *  - The method allowlist, batch limit and rate limit live in the route and apply before any upstream is chosen, so they are identical
 *    on every upstream.
 *  - Nothing that identifies an upstream (URL, host, key) is ever returned to a caller, put in a header, or logged: failures surface as
 *    one generic error, and any upstream body that is passed through is scrubbed of the configured URLs, hosts and keys.
 */
import { createHash } from "node:crypto";

export type RpcNetwork = "devnet" | "mainnet";

/** Genesis hashes of the two clusters this app talks to. */
export const CLUSTER_GENESIS: Readonly<Record<RpcNetwork, string>> = Object.freeze({
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
});

/** The devnet default when `DEVNET_RPC_FALLBACK_URLS` is unset. */
export const DEFAULT_DEVNET_FALLBACK = "https://api.devnet.solana.com";

const MAX_FALLBACKS = 4;

export interface UpstreamSpec {
  /** Opaque id (hash of the URL); safe to keep in memory, never sent anywhere. */
  id: string;
  url: string;
  headers: Record<string, string>;
  primary: boolean;
}

const idOf = (url: string): string => createHash("sha256").update(url).digest("hex").slice(0, 16);

/** Parse a comma-separated URL list: https only, valid URL, deduplicated, at most {@link MAX_FALLBACKS}. Invalid entries are dropped silently. */
export function parseFallbackUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    try {
      const u = new URL(s);
      if (u.protocol !== "https:" || !u.hostname) continue;
      if (!out.includes(s)) out.push(s);
    } catch {
      /* not a URL */
    }
    if (out.length >= MAX_FALLBACKS) break;
  }
  return out;
}

/** The configured fallbacks for a network (server env only). */
export function fallbackUrlsFor(network: RpcNetwork, env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = network === "devnet" ? env.DEVNET_RPC_FALLBACK_URLS : env.MAINNET_RPC_FALLBACK_URLS;
  if (raw === undefined) return network === "devnet" ? [DEFAULT_DEVNET_FALLBACK] : [];
  return parseFallbackUrls(raw);
}

/** Primary first, then the fallbacks in order (a fallback equal to the primary is dropped). */
export function buildUpstreams(network: RpcNetwork, primary: { url: string; headers: Record<string, string> }, env: NodeJS.ProcessEnv = process.env): UpstreamSpec[] {
  const list: UpstreamSpec[] = [{ id: idOf(primary.url), url: primary.url, headers: primary.headers, primary: true }];
  for (const url of fallbackUrlsFor(network, env)) {
    if (url === primary.url) continue;
    list.push({ id: idOf(url), url, headers: { "Content-Type": "application/json" }, primary: false });
  }
  return list;
}

/** The only error the pool throws: generic on purpose. */
export class UpstreamUnavailableError extends Error {
  constructor() {
    super("RPC upstream unavailable");
    this.name = "UpstreamUnavailableError";
  }
}

const FAIL_STATUS = (s: number): boolean => s === 401 || s === 403 || s === 408 || s === 429 || s >= 500;
const QUOTA_CODES = new Set([-32429, -32005]);
const QUOTA_TEXT = /max usage|rate.?limit|too many requests|quota|exhausted|credits/i;

function isQuotaItem(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const e = (x as { error?: { code?: unknown; message?: unknown } }).error;
  if (!e || typeof e !== "object") return false;
  if (typeof e.code === "number" && QUOTA_CODES.has(e.code)) return true;
  return typeof e.message === "string" && QUOTA_TEXT.test(e.message);
}

/** The upstream answered, but only to say it will not serve us (quota / rate limit). A batch fails only if EVERY item does. */
export function isQuotaBody(body: unknown): boolean {
  if (Array.isArray(body)) return body.length > 0 && body.every(isQuotaItem);
  return isQuotaItem(body);
}

export interface PoolDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cooldownBaseMs?: number;
  cooldownMaxMs?: number;
  /** How long a wrong-cluster verdict is kept before the fallback is checked again. */
  mismatchRecheckMs?: number;
  /** Receives a short, URL-free line. */
  warn?: (line: string) => void;
}

interface Health {
  fails: number;
  coolUntil: number;
}

export class UpstreamPool {
  private readonly health = new Map<string, Health>();
  private readonly cluster = new Map<string, { ok: boolean; until: number }>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly base: number;
  private readonly max: number;
  private readonly recheck: number;
  private readonly warn: (line: string) => void;

  constructor(d: PoolDeps = {}) {
    this.fetchImpl = d.fetchImpl ?? ((...a) => fetch(...a));
    this.now = d.now ?? Date.now;
    this.timeoutMs = d.timeoutMs ?? 15_000;
    this.base = d.cooldownBaseMs ?? 30_000;
    this.max = d.cooldownMaxMs ?? 300_000;
    this.recheck = d.mismatchRecheckMs ?? 600_000;
    this.warn = d.warn ?? ((l) => console.warn(l));
  }

  private coolUntil(u: UpstreamSpec): number {
    return this.health.get(u.id)?.coolUntil ?? 0;
  }

  private markFail(u: UpstreamSpec): void {
    const h = this.health.get(u.id) ?? { fails: 0, coolUntil: 0 };
    h.fails += 1;
    h.coolUntil = this.now() + Math.min(this.base * 2 ** (h.fails - 1), this.max);
    this.health.set(u.id, h);
  }

  private markOk(u: UpstreamSpec): void {
    this.health.delete(u.id);
  }

  /** Is this upstream cooling down right now? (exposed for tests and health output; carries no URL) */
  isCooling(u: UpstreamSpec): boolean {
    return this.coolUntil(u) > this.now();
  }

  /** One JSON-RPC POST to one upstream; throws on anything that should make the caller move on. */
  private async attempt(u: UpstreamSpec, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(u.url, { method: "POST", headers: u.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (FAIL_STATUS(res.status)) throw new Error("upstream status");
    const json: unknown = await res.json();
    if (isQuotaBody(json)) throw new Error("upstream quota");
    return json;
  }

  /** A fallback may serve only if it is on the deployment's cluster (genesis hash, cached). */
  private async clusterOk(u: UpstreamSpec, network: RpcNetwork): Promise<boolean> {
    const c = this.cluster.get(u.id);
    if (c && (c.ok || c.until > this.now())) return c.ok;
    try {
      const r = (await this.attempt(u, { jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] })) as { result?: unknown };
      const ok = typeof r?.result === "string" && r.result === CLUSTER_GENESIS[network];
      this.cluster.set(u.id, { ok, until: ok ? Infinity : this.now() + this.recheck });
      if (!ok) this.warn(`[rpc-upstreams] a ${network} fallback answered from a different cluster: ignored`);
      return ok;
    } catch {
      this.markFail(u); // could not tell: not cached, tried again after the cooldown
      return false;
    }
  }

  /**
   * POST `body` to the first healthy upstream. Returns the parsed JSON. Throws {@link UpstreamUnavailableError} (generic) when none
   * could answer.
   */
  async post(upstreams: readonly UpstreamSpec[], body: unknown, network: RpcNetwork): Promise<unknown> {
    const ready = upstreams.filter((u) => !this.isCooling(u));
    const order = ready.length > 0 ? ready : [...upstreams].sort((a, b) => this.coolUntil(a) - this.coolUntil(b));
    for (const u of order) {
      if (!u.primary && !(await this.clusterOk(u, network))) continue;
      try {
        const json = await this.attempt(u, body);
        this.markOk(u);
        return json;
      } catch {
        this.markFail(u);
      }
    }
    throw new UpstreamUnavailableError();
  }
}

/** Process-wide pool: cooldowns and cluster verdicts are shared by the proxy route and the server Connection helper. */
let shared: UpstreamPool | null = null;
export function sharedUpstreamPool(): UpstreamPool {
  return (shared ??= new UpstreamPool());
}
/** Test seam. */
export function __setSharedUpstreamPoolForTest(p: UpstreamPool | null): void {
  shared = p;
}

// ── Redaction ──────────────────────────────────────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s"'<>)]+/gi;
const KEY_PARAM_RE = /(api[-_]?key|token|secret|auth)=([^&\s"'<>]+)/gi;

/** The strings that identify the configured upstreams: full URL, host, and each query value (keys). */
export function secretsOf(upstreams: readonly UpstreamSpec[]): string[] {
  const out = new Set<string>();
  for (const u of upstreams) {
    out.add(u.url);
    try {
      const p = new URL(u.url);
      out.add(p.host);
      out.add(p.hostname);
      for (const v of p.searchParams.values()) if (v.length >= 6) out.add(v);
      for (const seg of p.pathname.split("/")) if (seg.length >= 12) out.add(seg);
      if (p.password) out.add(p.password);
      if (p.username) out.add(p.username);
    } catch {
      /* ignore */
    }
  }
  return [...out].filter((s) => s.length >= 4);
}

/** Free text (log lines, error messages): every URL and key-looking parameter replaced. */
export function redactText(text: string, upstreams: readonly UpstreamSpec[] = []): string {
  let t = text;
  for (const s of secretsOf(upstreams)) t = t.split(s).join("[redacted]");
  return t.replace(URL_RE, "[redacted-url]").replace(KEY_PARAM_RE, "$1=[redacted]");
}

/** A parsed upstream response about to go to the browser: scrubbed only if it mentions an upstream (no cost otherwise). */
export function redactJson<T>(data: T, upstreams: readonly UpstreamSpec[]): T {
  const secrets = secretsOf(upstreams);
  let s: string;
  try {
    s = JSON.stringify(data);
  } catch {
    return data;
  }
  if (s === undefined || !secrets.some((x) => s.includes(x))) return data;
  return JSON.parse(redactText(s, upstreams)) as T;
}

/** An error as a short URL-free log line. */
export function safeErrorText(e: unknown, upstreams: readonly UpstreamSpec[] = []): string {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return redactText(msg, upstreams).slice(0, 200);
}
