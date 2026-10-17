// @vitest-environment node
/** getServerConnection (faucet, cosign, markets...) rotates to the fallback when the primary is dead, and leaks no upstream detail. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTER_GENESIS } from "@/lib/rpc-upstreams";

const PRIMARY = "https://devnet.primary-rpc.test/v1/?api-key=PRIMARYKEY-0123456789";
const FB = "https://rpc.fallback-one.test/SECRETPATHTOKEN1234567890";
const realFetch = global.fetch;
let urls: string[];

async function conn(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else vi.stubEnv(k, v);
  }
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  return (await import("@/lib/server-rpc")).getServerConnection();
}
const rpc = (result: unknown, id: unknown = 1) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  urls = [];
});
afterEach(() => {
  global.fetch = realFetch;
  vi.unstubAllEnvs();
});

describe("getServerConnection fallback", () => {
  it("primary dead (429): the same call is answered by the fallback", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      urls.push(u);
      const { method: m, id } = JSON.parse(String(init?.body)) as { method: string; id: unknown };
      if (u === PRIMARY) return new Response(JSON.stringify({ error: { code: -32429, message: "max usage reached" } }), { status: 429 });
      return m === "getGenesisHash" ? rpc(CLUSTER_GENESIS.devnet, id) : rpc(4242, id);
    }) as typeof fetch;
    const c = await conn({ DEVNET_RPC_URL: PRIMARY, DEVNET_RPC_FALLBACK_URLS: FB });
    expect(await c.getSlot()).toBe(4242);
    expect(urls[0]).toBe(PRIMARY);
    expect(urls).toContain(FB);
  });

  it("everything dead: a generic error with no upstream host or key", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError(`fetch failed ${PRIMARY} ${FB}`);
    }) as typeof fetch;
    const c = await conn({ DEVNET_RPC_URL: PRIMARY, DEVNET_RPC_FALLBACK_URLS: FB });
    const e = await c.getSlot().catch((x) => x as Error);
    expect(e).toBeInstanceOf(Error);
    expect(`${e.message} ${e.stack ?? ""}`).not.toMatch(/primary-rpc|PRIMARYKEY|fallback-one|SECRETPATH/);
  });
});
