// @vitest-environment jsdom
/**
 * ChartPnlBadge must show PnL as soon as the market config is loaded, using the
 * on-chain `lastEffectivePriceE6` as the mark when the live price store has not
 * published a tick yet — instead of staying hidden for the few seconds until the
 * first live tick/seed arrives. Mirrors PositionsDock's `livePriceE6 ?? onChainPriceE6`.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Only primitives/bigints here — vi.hoisted runs BEFORE imports, so it can't
// reference the imported PublicKey. `collateralMint` is omitted because the
// useTokenMeta mock ignores its argument.
const h = vi.hoisted(() => ({
  livePrice: { priceE6: null as bigint | null, priceUsd: null as number | null },
  config: { lastEffectivePriceE6: 500_000n, invert: 0 } as Record<string, unknown> | null,
}));

const OWNER = new PublicKey("11111111111111111111111111111111");

vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: () => ({
    idx: 0,
    pubkey: OWNER,
    // Long; on-chain entry absent (0n) so it resolves via the local cache below.
    account: { kind: 0, owner: OWNER, positionSize: 1_000_000_000n, entryPrice: 0n, adlABasis: 0n, pnl: 0n },
  }),
}));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => h.livePrice }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({ config: h.config, params: { initialMarginBps: 1000n }, adlFactors: null }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
// Entry $0.40 from the local cache (saved when the position was opened).
vi.mock("@/lib/entry-price", () => ({ getEntryPrice: () => 400_000n }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccount: () => null }));

import { ChartPnlBadge } from "@/components/trade/ChartPnlBadge";

const SLAB = "So11111111111111111111111111111111111111112";

describe("ChartPnlBadge on-chain fallback", () => {
  beforeEach(() => {
    h.livePrice = { priceE6: null, priceUsd: null };
    h.config = { lastEffectivePriceE6: 500_000n, invert: 0 };
  });

  it("renders PnL from the on-chain config price when the live store has no tick yet", () => {
    render(<ChartPnlBadge slabAddress={SLAB} />);
    // Mark $0.50 (on-chain) > entry $0.40 on a long → positive PnL, badge visible.
    expect(screen.getByText("PnL")).toBeInTheDocument();
  });

  it("still hides when neither a live price NOR an on-chain config price is available", () => {
    h.config = null;
    render(<ChartPnlBadge slabAddress={SLAB} />);
    expect(screen.queryByText("PnL")).toBeNull();
  });
});
