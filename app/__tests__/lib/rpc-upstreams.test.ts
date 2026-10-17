// @vitest-environment node
/**
 * Ordered RPC upstreams (lib/rpc-upstreams.ts): rotation, cooldown + primary re-probe, cluster check, redaction, env parsing.
 * All upstream hosts and keys below are fake; the assertions are that none of them ever comes back out.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CLUSTER_GENESIS,
  DEFAULT_DEVNET_FALLBACK,
  UpstreamPool,
  UpstreamUnavailableError,
  buildUpstreams,
  fallbackUrlsFor,
  isQuotaBody,
  parseFallbackUrls,
  redactJson,
  redactText,
  safeErrorText,
} from "@/lib/rpc-upstreams";

const PRIMARY_URL = "https://devnet.primary-rpc.test/v1/?api-key=PRIMARYKEY-0123456789";
const FB1 = "https://rpc.fallback-one.test/SECRETPATHTOKEN1234567890";
const FB2 = "https://rpc.fallback-two.test/?token=FALLBACKTWOKEY12345";
const ENV = { DEVNET_RPC_FALLBACK_URLS: `${FB1}, ${FB2}` } as unknown as NodeJS.ProcessEnv;
const mk = (env = ENV) => buildUpstreams("devnet", { url: PRIMARY_URL, headers: { "Content-Type": "application/json", Origin: "https://o.test" } }, env);

type Reply = { status?: number; body?: unknown; text?: string; throws?: string };
function fakeNet(script: Record<string, Reply | ((n: number) => Reply)>, genesis: Record<string, string> = {}) {
  const calls: { url: string; method: string }[] = [];
  const counts: Record<string, number> = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; id: number };
    calls.push({ url, method: body.method });
    counts[url] = (counts[url] ?? 0) + 1;
    if (body.method === "getGenesisHash" && genesis[url] !== undefined) {
      return { status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: genesis[url] }) } as Response;
    }
    const r0 = script[url];
    const r = typeof r0 === "function" ? r0(counts[url]!) : r0 ?? { body: { jsonrpc: "2.0", id: body.id, result: "ok" } };
    if (r.throws) throw new Error(r.throws);
    return {
      status: r.status ?? 200,
      json: async () => {
        if (r.text !== undefined) throw new SyntaxError("Unexpected token < in JSON");
        return r.body ?? { jsonrpc: "2.0", id: body.id, result: "ok" };
      },
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const REQ = { jsonrpc: "2.0", id: 7, method: "getSlot", params: [] };
const G = CLUSTER_GENESIS.devnet;

describe("env parsing", () => {
  it("devnet defaults to the public devnet RPC when unset; mainnet to none", () => {
    expect(fallbackUrlsFor("devnet", {} as NodeJS.ProcessEnv)).toEqual([DEFAULT_DEVNET_FALLBACK]);
    expect(fallbackUrlsFor("mainnet", {} as NodeJS.ProcessEnv)).toEqual([]);
  });
  it("an explicit empty value turns the fallback off", () => {
    expect(fallbackUrlsFor("devnet", { DEVNET_RPC_FALLBACK_URLS: "" } as unknown as NodeJS.ProcessEnv)).toEqual([]);
  });
  it("https only, valid URLs only, deduplicated, capped", () => {
    expect(parseFallbackUrls("http://insecure.test, ftp://x.test, not a url, https://a.test, https://a.test,  ,https://b.test")).toEqual(["https://a.test", "https://b.test"]);
    expect(parseFallbackUrls(Array.from({ length: 9 }, (_, i) => `https://h${i}.test`).join(","))).toHaveLength(4);
  });
  it("reads the SERVER variables only (a NEXT_PUBLIC_ twin is ignored)", () => {
    const env = { NEXT_PUBLIC_DEVNET_RPC_FALLBACK_URLS: "https://leak.test" } as unknown as NodeJS.ProcessEnv;
    expect(fallbackUrlsFor("devnet", env)).toEqual([DEFAULT_DEVNET_FALLBACK]);
  });
  it("a fallback equal to the primary is dropped; the primary keeps the Origin header, fallbacks do not", () => {
    const l = buildUpstreams("devnet", { url: FB1, headers: { Origin: "https://o.test" } }, ENV);
    expect(l.map((u) => u.primary)).toEqual([true, false]);
    expect(mk()[0]!.headers.Origin).toBe("https://o.test");
    expect(mk()[1]!.headers.Origin).toBeUndefined();
  });
});

describe("rotation", () => {
  it("uses the primary while it is healthy and never touches a fallback", async () => {
    const net = fakeNet({});
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    expect(await pool.post(mk(), REQ, "devnet")).toMatchObject({ result: "ok" });
    expect(net.calls.map((c) => c.url)).toEqual([PRIMARY_URL]);
  });

  it.each([
    ["HTTP 429", { status: 429, body: { jsonrpc: "2.0", error: { code: -32429, message: "max usage reached" } } }],
    ["HTTP 401", { status: 401, body: { error: "Unauthorized" } }],
    ["HTTP 503", { status: 503, body: {} }],
    ["a 200 with a max-usage JSON-RPC error", { body: { jsonrpc: "2.0", id: 7, error: { code: -32429, message: "max usage reached" } } }],
    ["a rate-limit message", { body: { jsonrpc: "2.0", id: 7, error: { code: -32000, message: "Too many requests for this key" } } }],
    ["a network error", { throws: "fetch failed ECONNRESET" }],
    ["a non-JSON body", { status: 200, text: "<html>" }],
  ] as [string, Reply][])("moves on after %s", async (_n, bad) => {
    const net = fakeNet({ [PRIMARY_URL]: bad }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    expect(await pool.post(mk(), REQ, "devnet")).toMatchObject({ result: "ok" });
    expect(net.calls.map((c) => c.url)).toEqual([PRIMARY_URL, FB1, FB1]); // primary, fallback genesis check, fallback call
  });

  it("an application-level JSON-RPC error (simulation failure) is an ANSWER, not a reason to switch", async () => {
    const sim = { jsonrpc: "2.0", id: 7, error: { code: -32002, message: "Transaction simulation failed: custom program error: 0x1b" } };
    const net = fakeNet({ [PRIMARY_URL]: { body: sim } });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    expect(await pool.post(mk(), REQ, "devnet")).toEqual(sim);
    expect(net.calls).toHaveLength(1);
    expect(isQuotaBody(sim)).toBe(false);
  });

  it("a batch fails over only when EVERY item is a quota error", () => {
    const q = { error: { code: -32429, message: "max usage" } };
    expect(isQuotaBody([q, q])).toBe(true);
    expect(isQuotaBody([q, { result: 1 }])).toBe(false);
  });

  it("walks the whole list: second fallback answers when the primary and the first fail", async () => {
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 }, [FB1]: { status: 500 } }, { [FB1]: G, [FB2]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    expect(await pool.post(mk(), REQ, "devnet")).toMatchObject({ result: "ok" });
    expect(net.calls.filter((c) => c.method === "getSlot").map((c) => c.url)).toEqual([PRIMARY_URL, FB1, FB2]);
  });

  it("all dead: one generic error, nothing about the upstreams", async () => {
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 }, [FB1]: { status: 500 }, [FB2]: { throws: `connect ECONNREFUSED ${FB2}` } }, { [FB1]: G, [FB2]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    const e = await pool.post(mk(), REQ, "devnet").catch((x) => x as Error);
    expect(e).toBeInstanceOf(UpstreamUnavailableError);
    expect(e.message).toBe("RPC upstream unavailable");
    expect(JSON.stringify([e.message, e.name, e.stack ?? ""])).not.toMatch(/primary-rpc|fallback-|PRIMARYKEY|SECRETPATH|FALLBACKTWO/);
  });

  it("the same request body goes to every upstream (the allowlist is applied before, once)", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { method: string };
      if (b.method === "getGenesisHash") return { status: 200, json: async () => ({ result: G }) } as Response;
      seen.push(String(init.body));
      return url === PRIMARY_URL ? ({ status: 429, json: async () => ({}) } as Response) : ({ status: 200, json: async () => ({ result: 1 }) } as Response);
    }) as unknown as typeof fetch;
    await new UpstreamPool({ fetchImpl }).post(mk(), REQ, "devnet");
    expect(seen).toEqual([JSON.stringify(REQ), JSON.stringify(REQ)]);
  });
});

describe("cooldown and primary re-probe", () => {
  it("a failed primary is skipped during its cooldown, then probed FIRST again; one success resets it", async () => {
    let t = 1_000_000;
    let primaryDown = true;
    const net = fakeNet({ [PRIMARY_URL]: () => (primaryDown ? { status: 429 } : { body: { jsonrpc: "2.0", id: 7, result: "primary" } }), [FB1]: { body: { jsonrpc: "2.0", id: 7, result: "fb" } } }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl, now: () => t, cooldownBaseMs: 30_000, cooldownMaxMs: 120_000 });
    const ups = mk();
    expect(await pool.post(ups, REQ, "devnet")).toMatchObject({ result: "fb" });
    expect(pool.isCooling(ups[0]!)).toBe(true);
    const primaryHits = () => net.calls.filter((c) => c.url === PRIMARY_URL).length;
    expect(primaryHits()).toBe(1);
    t += 10_000; // inside the cooldown: not probed
    await pool.post(ups, REQ, "devnet");
    expect(primaryHits()).toBe(1);
    t += 25_000; // cooldown over: probed first, still down -> doubles
    await pool.post(ups, REQ, "devnet");
    expect(primaryHits()).toBe(2);
    t += 40_000; // 60 s cooldown not over yet
    await pool.post(ups, REQ, "devnet");
    expect(primaryHits()).toBe(2);
    primaryDown = false;
    t += 30_000; // over: probed, healthy again
    expect(await pool.post(ups, REQ, "devnet")).toMatchObject({ result: "primary" });
    expect(pool.isCooling(ups[0]!)).toBe(false);
    expect(await pool.post(ups, REQ, "devnet")).toMatchObject({ result: "primary" }); // and it stays first
  });

  it("the cooldown is capped", async () => {
    let t = 0;
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 } });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl, now: () => t, cooldownBaseMs: 1_000, cooldownMaxMs: 4_000 });
    const ups = buildUpstreams("devnet", { url: PRIMARY_URL, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: "" } as unknown as NodeJS.ProcessEnv);
    for (let i = 0; i < 8; i++) {
      await pool.post(ups, REQ, "devnet").catch(() => undefined);
      t += 4_001; // always past the (capped) cooldown
    }
    expect(net.calls.filter((c) => c.url === PRIMARY_URL)).toHaveLength(8);
  });

  it("when every upstream is cooling they are all still tried, soonest-ready first (no dead end)", async () => {
    let t = 0;
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 }, [FB1]: { status: 429 } }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl, now: () => t, cooldownBaseMs: 60_000 });
    const ups = buildUpstreams("devnet", { url: PRIMARY_URL, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: FB1 } as unknown as NodeJS.ProcessEnv);
    await pool.post(ups, REQ, "devnet").catch(() => undefined);
    t += 5;
    const before = net.calls.length;
    await pool.post(ups, REQ, "devnet").catch(() => undefined);
    expect(net.calls.length).toBeGreaterThan(before);
  });
});

describe("cluster check on fallbacks", () => {
  it("a fallback on another cluster is never used, and the primary is not asked to prove anything", async () => {
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 } }, { [FB1]: CLUSTER_GENESIS.mainnet, [FB2]: G });
    const warn = vi.fn();
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl, warn });
    expect(await pool.post(mk(), REQ, "devnet")).toMatchObject({ result: "ok" });
    expect(net.calls.some((c) => c.url === FB1 && c.method === "getSlot")).toBe(false);
    expect(net.calls.some((c) => c.url === FB2 && c.method === "getSlot")).toBe(true);
    expect(net.calls.some((c) => c.url === PRIMARY_URL && c.method === "getGenesisHash")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/fallback-one|SECRETPATH/);
  });

  it("the verdict is cached: one genesis call per fallback, however many requests", async () => {
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 } }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl, now: () => 0, cooldownBaseMs: 0 });
    const ups = buildUpstreams("devnet", { url: PRIMARY_URL, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: FB1 } as unknown as NodeJS.ProcessEnv);
    for (let i = 0; i < 4; i++) await pool.post(ups, REQ, "devnet");
    expect(net.calls.filter((c) => c.method === "getGenesisHash")).toHaveLength(1);
  });

  it("a wrong-cluster verdict is re-checked only after the long delay", async () => {
    let t = 0;
    let genesis = CLUSTER_GENESIS.mainnet;
    const base = fakeNet({ [PRIMARY_URL]: { status: 429 } });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { method: string };
      if (url === FB1 && b.method === "getGenesisHash") return { status: 200, json: async () => ({ result: genesis }) } as Response;
      return base.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const pool = new UpstreamPool({ fetchImpl, now: () => t, cooldownBaseMs: 0, mismatchRecheckMs: 600_000, warn: () => undefined });
    const ups = buildUpstreams("devnet", { url: PRIMARY_URL, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: FB1 } as unknown as NodeJS.ProcessEnv);
    await expect(pool.post(ups, REQ, "devnet")).rejects.toBeInstanceOf(UpstreamUnavailableError);
    genesis = G;
    t += 1_000;
    await expect(pool.post(ups, REQ, "devnet")).rejects.toBeInstanceOf(UpstreamUnavailableError); // cached verdict still wrong
    t += 600_000;
    await expect(pool.post(ups, REQ, "devnet")).resolves.toMatchObject({ result: "ok" });
  });

  it("a mainnet deployment checks against the mainnet genesis", async () => {
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 } }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl, warn: () => undefined });
    const ups = buildUpstreams("mainnet", { url: PRIMARY_URL, headers: {} }, { MAINNET_RPC_FALLBACK_URLS: FB1 } as unknown as NodeJS.ProcessEnv);
    await expect(pool.post(ups, REQ, "mainnet")).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it("a failed genesis call (cannot tell) is not cached as wrong: it is retried after the cooldown", async () => {
    let t = 0;
    let up = false;
    const base = fakeNet({ [PRIMARY_URL]: { status: 429 } });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { method: string };
      if (url === FB1 && b.method === "getGenesisHash") {
        if (!up) throw new Error("fetch failed");
        return { status: 200, json: async () => ({ result: G }) } as Response;
      }
      return base.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const pool = new UpstreamPool({ fetchImpl, now: () => t, cooldownBaseMs: 1_000 });
    const ups = buildUpstreams("devnet", { url: PRIMARY_URL, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: FB1 } as unknown as NodeJS.ProcessEnv);
    await expect(pool.post(ups, REQ, "devnet")).rejects.toBeInstanceOf(UpstreamUnavailableError);
    up = true;
    t += 60_000;
    await expect(pool.post(ups, REQ, "devnet")).resolves.toMatchObject({ result: "ok" });
  });
});

describe("redaction", () => {
  const ups = mk();
  it("text: configured URLs, hosts, keys and any URL / key parameter are replaced", () => {
    const t = redactText(`connect ECONNREFUSED ${PRIMARY_URL} then https://other.test/x?api-key=ZZZ999 host rpc.fallback-one.test path SECRETPATHTOKEN1234567890`, ups);
    expect(t).not.toMatch(/primary-rpc|PRIMARYKEY|other\.test|ZZZ999|fallback-one|SECRETPATH/);
  });
  it("json: an upstream body that echoes a URL or key is scrubbed; a clean one is returned untouched (same object)", () => {
    const dirty = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: `bad request to ${FB2}`, data: { key: "FALLBACKTWOKEY12345" } } };
    expect(JSON.stringify(redactJson(dirty, ups))).not.toMatch(/fallback-two|FALLBACKTWOKEY/);
    const clean = { jsonrpc: "2.0", id: 1, result: { value: 1 } };
    expect(redactJson(clean, ups)).toBe(clean);
  });
  it("error text for logs is short and URL-free", () => {
    const e = new TypeError(`fetch failed: getaddrinfo ENOTFOUND devnet.primary-rpc.test (${PRIMARY_URL})`);
    const t = safeErrorText(e, ups);
    expect(t).not.toMatch(/primary-rpc|PRIMARYKEY/);
    expect(t.length).toBeLessThanOrEqual(200);
  });
});
