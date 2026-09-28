/**
 * #2634: the dashboard's PositionSummary rendered a literal "—" for Liq
 * wherever collateral covers the position (no liquidation price) — the exact
 * symptom #2558 fixed on four other surfaces. It must show margin health.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ positions: [] as unknown[] }));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("@/hooks/usePortfolio", () => ({
  usePortfolio: () => ({ positions: state.positions, loading: false }),
  getLiquidationSeverity: () => "safe",
  isOpenPosition: (p: { account?: { positionSize?: bigint } }) => (p.account?.positionSize ?? 0n) !== 0n,
}));
vi.mock("@/hooks/useMultiTokenMeta", () => ({ useMultiTokenMeta: () => new Map() }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ connected: true }) }));
vi.mock("@/components/ui/GlowButton", () => ({ GlowButton: ({ children }: { children: React.ReactNode }) => <button>{children}</button> }));
vi.mock("@/components/ui/ShimmerSkeleton", () => ({ ShimmerSkeleton: () => null }));

import { PositionSummary } from "@/components/dashboard/PositionSummary";

const pos = (over: Record<string, unknown>) => ({
  slabAddress: "Slab111111111111111111111111111111111111111",
  symbol: "SOL-PERP",
  collateralMint: { toBase58: () => "Mint" },
  effectiveSize: 1_000_000n,
  leverage: 1,
  liquidationDistancePct: 100,
  oraclePriceE6: 100_000_000n,
  unrealizedPnl: 0n,
  pnlPercent: 0,
  maintenanceMarginBps: 500n,
  entryPriceSource: "onchain",
  account: { positionSize: 1_000_000n, capital: 200_000_000n, entryPrice: 100_000_000n },
  liquidationPriceE6: 0n,
  ...over,
});

describe("PositionSummary Liq cell", () => {
  it("shows margin health, not a bare dash, when collateral covers the position", () => {
    state.positions = [pos({})];
    render(<PositionSummary />);
    expect(screen.getByText("200% mgn")).toBeInTheDocument();
  });

  it("shows the price when a liquidation price exists", () => {
    state.positions = [pos({ liquidationPriceE6: 80_000_000n, account: { positionSize: 1_000_000n, capital: 50_000_000n, entryPrice: 100_000_000n } })];
    render(<PositionSummary />);
    expect(screen.queryByText(/mgn/)).toBeNull();
    expect(screen.getByText(/80/)).toBeInTheDocument();
  });

  it("does not present an unresolved entry as covered", () => {
    state.positions = [pos({ entryPriceSource: "unknown" })];
    render(<PositionSummary />);
    expect(screen.queryByText(/mgn/)).toBeNull();
  });
});
