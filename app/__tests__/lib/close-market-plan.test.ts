// @vitest-environment node
/**
 * Reclaim for a half-created v18 market — against the REAL bytes of the market a
 * tester got stuck on (2026-09-28, CaS8oiDW…: steps 1–2 landed, Initialize LP
 * failed; Reclaim failed with 0x15 EngineLockActive).
 *
 * CloseSlab only accepts a Resolved market with no capital and no portfolios, and
 * every half-created market is still Live, so reclaim has to send ResolveMarket
 * first. The same plan, built into a tx exactly like useCloseMarket, landed on a
 * surfpool fork of that market (CloseSlab alone reproduced Custom(21)).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { V17_MARKET_GROUP_OFF } from "@percolatorct/sdk";
import { planCloseMarket } from "@/lib/close-market-plan";
import { readMarketGroupHeader } from "@/lib/v18-wire";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "CaS8oiDW.market.json"), "utf-8"),
) as { dataBase64: string; dataLen: number };
const stuck = () => new Uint8Array(Buffer.from(fixture.dataBase64, "base64"));

const G = V17_MARKET_GROUP_OFF;
function withU64(data: Uint8Array, off: number, v: bigint): Uint8Array {
  const out = new Uint8Array(data);
  new DataView(out.buffer).setBigUint64(off, v, true);
  return out;
}

describe("readMarketGroupHeader — on real on-chain bytes", () => {
  it("reads the stuck wizard market exactly as the chain has it", () => {
    const data = stuck();
    expect(data.length).toBe(fixture.dataLen);
    expect(readMarketGroupHeader(data)).toEqual({
      mode: 0, // Live — InitMarket left it there
      nextMarketId: 15n, // 14-slot "max capacity" market: max_market_slots + 1
      cTot: 0n,
      materializedPortfolioCount: 0n,
    });
  });
});

describe("planCloseMarket", () => {
  it("a Live, empty, half-created market is resolved first, bound to its own frontier and epoch", () => {
    // authority_epoch is 1, not 0: the launch's keeper co-sign delegated the
    // oracle authority, which advances asset 0's epoch.
    expect(planCloseMarket(stuck())).toEqual({
      ok: true,
      authorityEpoch: 1n,
      resolve: { assetGenerationFrontier: 15n },
    });
  });

  it("an already-Resolved market needs CloseSlab only", () => {
    const resolved = stuck();
    resolved[G + 626] = 1;
    expect(planCloseMarket(resolved)).toEqual({ ok: true, authorityEpoch: 1n, resolve: null });
  });

  it("refuses before signing when the market holds user capital", () => {
    expect(planCloseMarket(withU64(stuck(), G + 317, 5_000_000n))).toEqual({
      ok: false,
      reason: "holds-capital",
    });
  });

  it("refuses before signing when the market has portfolios", () => {
    expect(planCloseMarket(withU64(stuck(), G + 517, 1n))).toEqual({
      ok: false,
      reason: "holds-capital",
    });
  });
});
