// @vitest-environment node
/**
 * #3320: a creator's live-priced markets and the per-creator ceiling, read with the SAME filter
 * and caps keeper-register enforces. The parity test runs the real guard and the real read over
 * one fake `markets` table: for a slab not yet enrolled, the read says atLimit exactly when the
 * guard refuses with the per-creator 403.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { checkEnrollmentCaps, PER_CREATOR_CAP_COPY, readCreatorCapacity } from "@/lib/keeper-enrollment-guard";

type Row = { slab_address: string; deployer: string; network: string; keeper_status: string };

/** Minimal PostgREST-shaped builder over an array: eq / neq / limit, count+head. */
function fakeSupabase(rows: Row[], opts: { fail?: boolean } = {}) {
  return {
    from: () => ({
      select: (_cols: string, sel?: { count?: string; head?: boolean }) => {
        const filters: ((r: Row) => boolean)[] = [];
        const q = {
          eq: (k: keyof Row, v: string) => (filters.push((r) => r[k] === v), q),
          neq: (k: keyof Row, v: string) => (filters.push((r) => r[k] !== v), q),
          limit: () => q,
          then: (res: (v: unknown) => unknown) => {
            if (opts.fail) return Promise.resolve({ data: null, count: null, error: { message: "boom" } }).then(res);
            const out = rows.filter((r) => filters.every((f) => f(r)));
            return Promise.resolve(sel?.head ? { count: out.length, error: null } : { data: out.map((r) => ({ slab_address: r.slab_address })), error: null }).then(res);
          },
        };
        return q;
      },
    }),
  } as never;
}

const W = "7Q3CVASeMNyYX4Q5zc7xCNhiCPZeSoMNLnYACUBR5qeQ";
const OTHER = "4bXx1ioqZ5XLC86DCwuCtu8mPfS9MT9EEY12SxH1FEGa";
const rows = (n: number, over: Partial<Row> = {}): Row[] =>
  Array.from({ length: n }, (_, i) => ({ slab_address: `S${i}`, deployer: W, network: "devnet", keeper_status: "active", ...over }));
const caps = { maxActive: 90, maxActivePerCreator: 10 };

describe("readCreatorCapacity", () => {
  it("lists only this wallet's ACTIVE rows on this network", async () => {
    const table = [
      ...rows(3),
      ...rows(2, { keeper_status: "retired", slab_address: "R" }),
      ...rows(2, { network: "mainnet", slab_address: "M" }),
      ...rows(4, { deployer: OTHER, slab_address: "O" }),
    ];
    const cap = await readCreatorCapacity(fakeSupabase(table), { deployer: W, network: "devnet" }, caps);
    expect(cap).toEqual({ ok: true, activeSlabs: ["S0", "S1", "S2"], max: 10, atLimit: false });
  });

  it("at the ceiling is atLimit", async () => {
    const cap = await readCreatorCapacity(fakeSupabase(rows(10)), { deployer: W, network: "devnet" }, caps);
    expect(cap).toMatchObject({ ok: true, atLimit: true, max: 10 });
  });

  it("a failed read is unknown, never a verdict", async () => {
    expect(await readCreatorCapacity(fakeSupabase(rows(10), { fail: true }), { deployer: W, network: "devnet" }, caps)).toEqual({ ok: false });
  });

  it("PARITY: for a new slab, atLimit iff keeper-register's guard refuses it per-creator", async () => {
    for (let n = 0; n <= 12; n++) {
      const sb = fakeSupabase(rows(n));
      const read = await readCreatorCapacity(sb, { deployer: W, network: "devnet" }, caps);
      const guard = await checkEnrollmentCaps(sb, { slab: "NEW", deployer: W, network: "devnet" }, caps);
      const refusedPerCreator = !guard.ok && guard.error === PER_CREATOR_CAP_COPY;
      expect(read.ok && read.atLimit).toBe(refusedPerCreator);
    }
  });
});

const h = vi.hoisted(() => ({ supabase: null as unknown, throwClient: false, allowed: true }));
vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => {
    if (h.throwClient) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
    return h.supabase;
  },
  getServerNetwork: () => "devnet",
}));
vi.mock("@/lib/upstash-rate-limit", () => ({
  createUpstashRateLimiter: () => ({ check: async () => ({ allowed: h.allowed, remaining: 0 }) }),
}));

import { GET } from "@/app/api/playground/keeper-capacity/route";

const req = (wallet: string) => new NextRequest(`http://localhost/api/playground/keeper-capacity?wallet=${wallet}`);

describe("GET /api/playground/keeper-capacity", () => {
  beforeEach(() => {
    h.supabase = fakeSupabase(rows(10));
    h.throwClient = false;
    h.allowed = true;
  });

  it("returns the wallet's active slabs, the ceiling and atLimit, uncached", async () => {
    const res = await GET(req(W));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.atLimit).toBe(true);
    expect(body.max).toBe(10);
    expect(body.activeSlabs).toHaveLength(10);
  });

  it("an invalid wallet is 400", async () => {
    expect((await GET(req("not-a-key"))).status).toBe(400);
  });

  it("a failed count or an unconfigured database is 503 and never echoes the reason", async () => {
    h.supabase = fakeSupabase([], { fail: true });
    const a = await GET(req(W));
    expect(a.status).toBe(503);
    expect(JSON.stringify(await a.json())).not.toContain("boom");
    h.throwClient = true;
    const b = await GET(req(W));
    expect(b.status).toBe(503);
    expect(JSON.stringify(await b.json())).not.toContain("SUPABASE");
  });

  it("rate limited is 429", async () => {
    h.allowed = false;
    expect((await GET(req(W))).status).toBe(429);
  });
});
