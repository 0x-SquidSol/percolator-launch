/**
 * AUTH_MARK push freshness on REAL devnet v18 bytes.
 *
 * TRUMP (CdN8r7FB, oracle_mode 3) was captured while the keeper republished a
 * HELD mark every ~1.5s: PushAuthMark stamps `last_good_oracle_slot` on every
 * accepted push (0 slots behind the capture slot) but only moves
 * `mark_ewma_last_slot` when the price value changes (15,615 slots ≈ 1.7h
 * behind). Freshness measured from the latter read STALE and blocked trading
 * and closing while pushes were landing.
 *
 * The fail-closed guarantee from GH#2583 is re-proven on the same bytes: move
 * the chain an hour past the capture (no further pushes) and it must block.
 */
import fs from "fs";
import path from "path";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { parseWrapperConfigV17, type WrapperConfigV17 } from "@percolatorct/sdk";

let slabState: Record<string, unknown> = {};
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => slabState }));

const mocks = vi.hoisted(() => ({ getSlot: vi.fn() }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: { getSlot: mocks.getSlot } }),
}));

import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { isOracleStaleBlocking } from "@/lib/oracle-stale-gate";
import { isKeeperFeedDead } from "@/components/my-markets/attentionLogic";

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../fixtures/CdN8r7FB.freshness.market.json"), "utf8"),
) as { contextSlot: number; dataBase64: string };
const CAPTURE_SLOT = BigInt(fixture.contextSlot);
const cfg: WrapperConfigV17 = parseWrapperConfigV17(new Uint8Array(Buffer.from(fixture.dataBase64, "base64")));

function slabFromLiveBytes(wrapperConfigV17: WrapperConfigV17) {
  // Mirrors SlabProvider's v17 shim for a mode-3 market (indexFeedId forced
  // to zero, lastEffectivePriceE6 = markEwmaE6, engine null).
  return {
    config: {
      oracleAuthority: new PublicKey("Sysvar1111111111111111111111111111111111112"),
      indexFeedId: PublicKey.default,
      authorityTimestamp: 0n,
      authorityPriceE6: wrapperConfigV17.markEwmaE6,
      lastEffectivePriceE6: wrapperConfigV17.markEwmaE6,
      collateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
    },
    engine: null,
    wrapperConfigV17,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  slabState = slabFromLiveBytes(cfg);
});
afterEach(() => vi.useRealTimers());

describe("useOracleFreshness — AUTH_MARK push clock (live TRUMP bytes)", () => {
  it("premise: the captured market is AUTH_MARK with a held mark", () => {
    expect(cfg.oracleMode).toBe(3);
    expect(CAPTURE_SLOT - cfg.markEwmaLastSlot).toBeGreaterThan(15_000n);
    expect(CAPTURE_SLOT - cfg.lastGoodOracleSlot).toBeLessThan(10n);
  });

  it("a held mark that is still being pushed reads FRESH and does not block trading", async () => {
    mocks.getSlot.mockResolvedValue(Number(CAPTURE_SLOT));
    const { result, unmount } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    await waitFor(() => expect(mocks.getSlot).toHaveBeenCalled());
    await waitFor(() => expect(result.current.elapsedSecs).toBeLessThan(10));
    expect(result.current.mode).toBe("keeper");
    expect(result.current.level).toBe("fresh");
    expect(isOracleStaleBlocking(result.current.level, result.current.mode, result.current.ready)).toBe(false);
    unmount();
  });

  it("FAIL-CLOSED (#2583): the same bytes an hour later with no pushes read STALE and block", async () => {
    mocks.getSlot.mockResolvedValue(Number(CAPTURE_SLOT + 9_000n));
    const { result, unmount } = renderHook(() => useOracleFreshness());
    await waitFor(() => expect(result.current.level).toBe("stale"));
    expect(isOracleStaleBlocking(result.current.level, result.current.mode, result.current.ready)).toBe(true);
    unmount();
  });

  it("My Markets: the held-but-pushed feed is not 'dead'; an hour without pushes is", () => {
    const market = { configV17: cfg } as unknown as Parameters<typeof isKeeperFeedDead>[0];
    expect(isKeeperFeedDead(market, CAPTURE_SLOT)).toBe(false);
    expect(isKeeperFeedDead(market, CAPTURE_SLOT + 9_000n)).toBe(true);
  });
});
