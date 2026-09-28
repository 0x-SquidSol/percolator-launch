/**
 * Real-hook behavioral test for the `ws.onmessage` trade handler in
 * usePercolatorCandles — the two sibling fixes that landed on the same
 * handler:
 *
 *  - #2604/#2605: a `trade` message with a null/0 price (the liquidation-marker
 *    contract — `insertTradeRow` writes NULL price for `is_liquidation` rows)
 *    must NOT become an o=h=l=c=0 bar. `Number(null)` and `Number(0)` are both
 *    finite, so a bare `Number.isFinite(price)` check admits it; the fix rejects
 *    any `price <= 0`.
 *  - #2609/#2611: a genuine fill into a market with no indexed candles must
 *    flip `status` from "empty" to "success" live, not just append to
 *    `candles` — `chart-source-select.ts` gates on `status === "success"`, so
 *    without this the user's own trade sits invisible until the next
 *    (slab, timeframe) refetch.
 *
 * This drives the REAL hook via `renderHook` with a scripted `WebSocket`,
 * rather than scraping the source string, so it actually exercises the
 * behavior and fails on a revert of either fix (see the "negative control"
 * note in the PR review — this file is the test #2605 shipped without).
 *
 * Each test uses its own slab address so the hook's module-level
 * `emptyCache`/`candleCache` (keyed by `${slab}:${timeframe}`) can't leak
 * state between cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePercolatorCandles } from "@/hooks/usePercolatorCandles";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.();
  }
}

function send(ws: FakeWebSocket, msg: unknown): void {
  act(() => {
    ws.onmessage?.({ data: JSON.stringify(msg) });
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  process.env.NEXT_PUBLIC_WS_URL = "ws://localhost:8787";
  // No indexed candles for this (slab, timeframe) — the "previously-empty
  // market" condition both #2604 and #2609 describe.
  global.fetch = vi.fn(
    async () => new Response(JSON.stringify({ s: "no_data" }), { status: 200 }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_WS_URL;
  vi.restoreAllMocks();
});

async function mountAndGetSocket(slab: string) {
  const view = renderHook(() => usePercolatorCandles(slab, "1h"));
  await waitFor(() => expect(view.result.current.status).toBe("empty"));
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  expect(ws).toBeTruthy();
  return { ws, ...view };
}

describe("usePercolatorCandles: live WS trade handler", () => {
  it("rejects a null-price liquidation marker — no bar, status stays empty (#2604)", async () => {
    const { ws, result } = await mountAndGetSocket("SLAB-NULL-PRICE");

    send(ws, { type: "trade", slab: "SLAB-NULL-PRICE", price: null, size: "5", timestamp: Date.now() });

    expect(result.current.candles).toHaveLength(0);
    expect(result.current.status).toBe("empty");
  });

  it("rejects a 0-price trade the same way — Number(null) coerces to a finite 0 (#2604)", async () => {
    const { ws, result } = await mountAndGetSocket("SLAB-ZERO-PRICE");

    send(ws, { type: "trade", slab: "SLAB-ZERO-PRICE", price: 0, size: "5", timestamp: Date.now() });

    expect(result.current.candles).toHaveLength(0);
    expect(result.current.status).toBe("empty");
  });

  it("a genuine fill into an empty market appends a bar AND flips status to success (#2609)", async () => {
    const { ws, result } = await mountAndGetSocket("SLAB-LIVE-FILL");

    send(ws, { type: "trade", slab: "SLAB-LIVE-FILL", price: 150.25, size: "5", timestamp: Date.now() });

    expect(result.current.candles).toHaveLength(1);
    expect(result.current.candles[0].close).toBe(150.25);
    expect(result.current.status).toBe("success");
  });

  it("a rejected priceless marker never flips status — only a real fill does (#2604 + #2609 together)", async () => {
    const { ws, result } = await mountAndGetSocket("SLAB-MARKER-THEN-FILL");

    // A liquidation marker arrives first: must not paint a bar or fake "success".
    send(ws, { type: "trade", slab: "SLAB-MARKER-THEN-FILL", price: null, size: "3", timestamp: Date.now() });
    expect(result.current.candles).toHaveLength(0);
    expect(result.current.status).toBe("empty");

    // A real fill follows: now it should surface live.
    send(ws, { type: "trade", slab: "SLAB-MARKER-THEN-FILL", price: 42, size: "1", timestamp: Date.now() });
    expect(result.current.candles).toHaveLength(1);
    expect(result.current.status).toBe("success");
  });
});
