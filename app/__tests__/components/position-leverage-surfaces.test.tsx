/**
 * Position leverage on the list surfaces, from REAL devnet v18 portfolio bytes.
 * Lev = |basisPosQ| x mark / (capital + pnl). The chain stores NO entry leverage
 * (asserted below on the parsed portfolio's field names).
 *
 * Positions are built by the REAL `buildV17Position` from REAL devnet v18
 * portfolio bytes (wrapper GnwdeQr…, captured 2026-09-29):
 *   2SewEcvf… short leg, on-chain pnl ≠ 0  → entry "derived" from pnl
 *   DAC2a44p… long leg,  on-chain pnl = 0  → entry "unknown" (unless cached)
 * Neither account stores an entry — `account.entryPrice` is structurally 0n on
 * v17/v18 (engine PortfolioLegV16 has basis/a_basis/k_snap/f_snap, no entry).
 */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";

const state = vi.hoisted(() => ({ positions: [] as unknown[] }));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("next/dynamic", () => ({ default: () => () => <button>ConnectButton</button> }));
vi.mock("@/hooks/usePortfolio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/usePortfolio")>();
  return {
    ...actual,
    usePortfolio: () => ({
      positions: state.positions,
      totalPnl: 0n,
      totalDeposited: 0n,
      totalValue: 0n,
      totalUnrealizedPnl: 0n,
      atRiskCount: 0,
      loading: false,
      isRefreshing: false,
      refresh: () => {},
    }),
  };
});
vi.mock("@/hooks/useMultiTokenMeta", () => ({ useMultiTokenMeta: () => new Map() }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ connected: true, publicKey: new PublicKey("11111111111111111111111111111111") }),
}));
vi.mock("@/hooks/useLpPositions", () => ({
  useLpPositions: () => ({ positions: [], totalRedeemable: 0, loading: false, isRefreshing: false, error: null, refresh: () => {} }),
}));
vi.mock("@/components/portfolio/LpPositionsPanel", () => ({ LpPositionsPanel: () => null }));
vi.mock("@/hooks/useTraderStats", () => ({ useTraderStats: () => ({ stats: null, loading: false, error: null, refresh: () => {} }) }));
vi.mock("@/components/trade/TradeStatsPanel", () => ({ TradeStatsPanel: () => null }));
vi.mock("@/hooks/useAllMarketStats", () => ({ useAllMarketStats: () => ({ statsMap: new Map() }) }));
vi.mock("@/hooks/useLiveSlabPrices", () => ({ useLiveSlabPrices: () => new Map() }));
vi.mock("@/components/ui/ScrollReveal", () => ({ ScrollReveal: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ui/GlowButton", () => ({ GlowButton: ({ children }: { children: React.ReactNode }) => <button>{children}</button> }));
vi.mock("@/components/ui/ShimmerSkeleton", () => ({ ShimmerSkeleton: () => null }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false, getMockPortfolioPositions: () => [] }));

import { buildV17Position, type PortfolioPosition } from "@/hooks/usePortfolio";
import { PositionSummary } from "@/components/dashboard/PositionSummary";
import { PortfolioPositionsView } from "@/components/portfolio/PortfolioPositionsView";

function loadPortfolio(name: string) {
  const f = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../fixtures/${name}.portfolio.json`), "utf8")) as {
    market: string;
    dataBase64: string;
  };
  return { market: f.market, portfolio: parsePortfolioV17(Buffer.from(f.dataBase64, "base64")) };
}

const MARK = 1_000_000n; // $1.000000 — any positive mark exercises the paths
const WALLET = "11111111111111111111111111111111";

function build(name: string): PortfolioPosition {
  const { market, portfolio } = loadPortfolio(name);
  const discovered = {
    slabAddress: new PublicKey(market),
    programId: new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ"),
    config: {},
    configV17: { collateralMint: new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC") },
  } as never;
  return buildV17Position(portfolio, MARK, 500n, market, discovered, false, 1000n, "TEST-PERP", WALLET, null);
}


beforeEach(() => {
  localStorage.clear();
  state.positions = [];
});

const fmt = (v: number) => `${Number(v.toFixed(2)).toString()}×`;

describe("real v18 portfolio: what the chain stores", () => {
  it("has no entry price / entry leverage field on the portfolio or its legs", () => {
    const { portfolio } = loadPortfolio("2SewEcvf");
    const keys = [...Object.keys(portfolio), ...Object.keys(portfolio.legs.find((l) => l.active)!)].join(",").toLowerCase();
    expect(keys).not.toMatch(/leverage/);
    expect(keys).not.toMatch(/entry/);
  });
});

describe("position leverage on the list surfaces (real bytes)", () => {
  const expected = () => {
    const { portfolio } = loadPortfolio("2SewEcvf");
    const leg = portfolio.legs.find((l) => l.active)!;
    const absQ = leg.basisPosQ < 0n ? -leg.basisPosQ : leg.basisPosQ;
    const equity = portfolio.capital + portfolio.pnl;
    // mark $1.000000 (MARK): notional atoms (6-dec collateral) == |Q|
    return { leverage: Number((absQ * 10_000n) / equity) / 10_000, equity };
  };

  it("portfolio list badge + stat show Lev = notional / (capital + pnl)", () => {
    const { leverage, equity } = expected();
    expect(equity).toBeGreaterThan(0n); // CONTROL: fixture is solvent
    state.positions = [build("2SewEcvf")];
    render(<PortfolioPositionsView />);
    expect(screen.getByTestId("position-leverage-badge").textContent).toBe(`Lev ${fmt(leverage)}`);
    expect(screen.getByTestId("position-leverage-badge").getAttribute("title")).toMatch(/cross/i);
  });

  it("dashboard PositionSummary shows the same figure", () => {
    const { leverage } = expected();
    state.positions = [build("2SewEcvf")];
    render(<PositionSummary />);
    expect(screen.getByText(`Lev ${fmt(leverage)}`)).toBeInTheDocument();
  });
});
