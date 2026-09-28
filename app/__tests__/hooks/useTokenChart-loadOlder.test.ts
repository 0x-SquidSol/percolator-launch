/**
 * Tests for useTokenChart's loadOlder() — #2581 scroll-back paging.
 *
 * Covers the contract TradingChart's range-change handler relies on:
 *   1. loadOlder() fetches with `before` = the oldest held bar's timestamp
 *      (in unix SECONDS) and PREPENDS the result.
 *   2. Calling it again while a request is already in flight is a no-op
 *      (in-flight dedupe — #2578's shared quota can't absorb a duplicate
 *      request per range-change tick while panning).
 *   3. An empty or short page latches "no more history" — a further call
 *      never fetches again for that (mint, timeframe).
 *   4. A periodic repoll of page 1 (the normal 60s poll) does NOT discard
 *      bars already paged in by a prior loadOlder() call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useTokenChart } from "@/hooks/useTokenChart";

const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT_C = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const MINT_D = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

function candle(timestampMs: number) {
  return { timestamp: timestampMs, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
}

describe("useTokenChart loadOlder (#2581)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches with `before` = oldest held bar (in seconds) and prepends the result", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      const isOlderPage = url.includes("before=");
      return {
        ok: true,
        json: async () => ({
          candles: isOlderPage
            ? [candle(1_000_000), candle(2_000_000)] // older page: earlier timestamps
            : [candle(10_000_000), candle(11_000_000)], // page 1
          poolAddress: "pool1",
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTokenChart(MINT_A, "1h"));
    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.candles.map((c) => c.timestamp)).toEqual([10_000_000, 11_000_000]);

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.candles.length).toBe(4));

    // Prepended, not replaced — the original page-1 bars are still present.
    expect(result.current.candles.map((c) => c.timestamp)).toEqual([
      1_000_000, 2_000_000, 10_000_000, 11_000_000,
    ]);

    const olderCall = calls.find((u) => u.includes("before="));
    expect(olderCall).toBeDefined();
    // Oldest held bar was 10_000_000 ms -> 10_000 seconds.
    expect(olderCall).toContain("before=10000");
  });

  it("de-dupes an in-flight loadOlder() call — a second call while the first is pending fetches nothing extra", async () => {
    let resolveOlder: ((v: unknown) => void) | null = null;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("before=")) {
        return new Promise((resolve) => {
          resolveOlder = resolve;
        });
      }
      return {
        ok: true,
        json: async () => ({ candles: [candle(10_000_000)], poolAddress: "pool1" }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTokenChart(MINT_B, "1h"));
    await waitFor(() => expect(result.current.status).toBe("success"));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.isLoadingOlder).toBe(true));
    const callsAfterFirst = fetchMock.mock.calls.filter((c) => (c[0] as string).includes("before=")).length;
    expect(callsAfterFirst).toBe(1);

    // Second call while the first is still pending must be a no-op.
    act(() => result.current.loadOlder());
    const callsAfterSecond = fetchMock.mock.calls.filter((c) => (c[0] as string).includes("before=")).length;
    expect(callsAfterSecond).toBe(1);

    // Let the in-flight request resolve.
    await act(async () => {
      resolveOlder?.({
        ok: true,
        json: async () => ({ candles: [candle(1_000_000)], poolAddress: "pool1" }),
      });
    });
    await waitFor(() => expect(result.current.isLoadingOlder).toBe(false));
  });

  it("latches hasMoreHistory=false on an empty page and never fetches again for that key", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("before=")) {
        return { ok: true, json: async () => ({ candles: [], poolAddress: "pool1" }) } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ candles: [candle(10_000_000)], poolAddress: "pool1" }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTokenChart(MINT_C, "1h"));
    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.hasMoreHistory).toBe(true);

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.hasMoreHistory).toBe(false));

    const callsBefore = fetchMock.mock.calls.filter((c) => (c[0] as string).includes("before=")).length;
    expect(callsBefore).toBe(1);

    // A further call must not spend another request re-confirming "no more".
    act(() => result.current.loadOlder());
    const callsAfter = fetchMock.mock.calls.filter((c) => (c[0] as string).includes("before=")).length;
    expect(callsAfter).toBe(1);
  });

  it("a periodic page-1 repoll does not discard bars already paged in by loadOlder()", async () => {
    let pollCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("before=")) {
        return {
          ok: true,
          json: async () => ({ candles: [candle(1_000_000)], poolAddress: "pool1" }),
        } as unknown as Response;
      }
      pollCount += 1;
      return {
        ok: true,
        json: async () => ({ candles: [candle(10_000_000), candle(11_000_000)], poolAddress: "pool1" }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTokenChart(MINT_D, "1h"));
    await waitFor(() => expect(result.current.status).toBe("success"));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.candles.length).toBe(3));
    expect(result.current.candles.map((c) => c.timestamp)).toEqual([1_000_000, 10_000_000, 11_000_000]);

    // Simulate the periodic poll's repoll of page 1 via a manual refresh
    // (same code path fetchData uses — the 60s interval calls the identical
    // function).
    expect(pollCount).toBe(1);
    act(() => result.current.refresh());
    await waitFor(() => expect(pollCount).toBe(2));

    // The scrolled-back bar must still be there — a naive repoll would have
    // replaced the whole series with just the fresh 2-bar page-1 response.
    await waitFor(() =>
      expect(result.current.candles.map((c) => c.timestamp)).toEqual([1_000_000, 10_000_000, 11_000_000]),
    );
  });
});
