/** #3320: the creator's live-price capacity, read for the UI. Unknown never blocks anything. */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cappedFor, parseCapacity, useLivePriceCapacity } from "@/hooks/useLivePriceCapacity";
import { MARKET_REGISTERED_EVENT } from "@/lib/keeper-register-client";

const W = "7Q3CVASeMNyYX4Q5zc7xCNhiCPZeSoMNLnYACUBR5qeQ";
let body: unknown;
let status: number;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  body = { activeSlabs: ["A", "B"], max: 2, atLimit: true };
  status = 200;
  fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("cappedFor / parseCapacity", () => {
  it("a slab already live-priced is never capped; a new one is, at the limit", () => {
    const cap = parseCapacity({ activeSlabs: ["A"], max: 1, atLimit: true });
    expect(cappedFor(cap, "A")).toBe(false);
    expect(cappedFor(cap, "NEW")).toBe(true);
    expect(cappedFor(parseCapacity({ activeSlabs: [], max: 10, atLimit: false }), "NEW")).toBe(false);
  });
  it("anything malformed is unknown", () => {
    expect(parseCapacity(null).status).toBe("unknown");
    expect(parseCapacity({ max: 10, atLimit: true }).status).toBe("unknown");
    expect(cappedFor(parseCapacity({ error: "x" }), "NEW")).toBe(false);
  });
});

describe("useLivePriceCapacity", () => {
  it("reads the wallet's capacity", async () => {
    const { result } = renderHook(() => useLivePriceCapacity(W));
    await waitFor(() => expect(result.current.status).toBe("atLimit"));
    expect(result.current.max).toBe(2);
    expect(fetchMock.mock.calls[0][0]).toContain(`wallet=${W}`);
  });

  it("no wallet, disabled, an error status or a network error: unknown", async () => {
    expect(renderHook(() => useLivePriceCapacity(null)).result.current.status).toBe("unknown");
    expect(renderHook(() => useLivePriceCapacity(W, false)).result.current.status).toBe("unknown");
    status = 503;
    body = { error: "x" };
    const a = renderHook(() => useLivePriceCapacity(W));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(a.result.current.status).toBe("unknown");
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const b = renderHook(() => useLivePriceCapacity(W));
    await act(async () => { await Promise.resolve(); });
    expect(b.result.current.status).toBe("unknown");
  });

  it("re-reads when a market registers", async () => {
    const { result } = renderHook(() => useLivePriceCapacity(W));
    await waitFor(() => expect(result.current.status).toBe("atLimit"));
    body = { activeSlabs: ["A"], max: 2, atLimit: false };
    await act(async () => { window.dispatchEvent(new CustomEvent(MARKET_REGISTERED_EVENT, { detail: { slab: "A" } })); });
    await waitFor(() => expect(result.current.status).toBe("ok"));
  });
});
