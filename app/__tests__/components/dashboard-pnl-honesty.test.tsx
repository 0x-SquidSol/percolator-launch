/**
 * GH#2677: the dashboard must not present time-based PnL figures it has no
 * data for. "Today's PnL" was a hard-coded "--", "Total PnL" claimed "All
 * time" for what is open-position unrealized PnL, and the PnL chart's
 * 24H/7D/30D/ALL selector changed only the highlighted button.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/usePortfolio", () => ({
  isOpenPosition: () => true,
  usePortfolio: () => ({
    loading: false,
    totalUnrealizedPnl: 6_690_000n,
    positions: [
      { unrealizedPnl: 6_690_000n, market: { configV17: { tradeFeeBps: 30n } } },
    ],
  }),
}));

import { StatsBar } from "@/components/dashboard/StatsBar";
import { PnlChart } from "@/components/dashboard/PnlChart";

describe("StatsBar", () => {
  it("has no data-less Today's PnL card and no 'All time' claim", () => {
    render(<StatsBar />);
    expect(screen.queryByText(/Today's PnL/i)).toBeNull();
    expect(screen.queryByText(/All time/i)).toBeNull();
    expect(screen.getByText("Unrealized PnL")).toBeTruthy();
    expect(screen.getByText("+$6.69")).toBeTruthy();
  });
});

describe("PnlChart", () => {
  it("renders the current unrealized PnL with no decorative range selector", () => {
    render(<PnlChart />);
    for (const r of ["24H", "7D", "30D", "ALL"]) expect(screen.queryByRole("button", { name: r })).toBeNull();
    expect(screen.getByText(/Unrealized · now/)).toBeTruthy();
    expect(screen.getByText("+$6.69")).toBeTruthy();
  });
});

describe("StatsBar in-profit card", () => {
  it("no longer renders the 'In Profit' block (removed as noise); PnL + Trade Fee remain", () => {
    render(<StatsBar />);
    expect(screen.queryByText("In Profit")).toBeNull();
    expect(screen.queryByText("Win Rate")).toBeNull();
    expect(screen.queryByText(/up \/ .*down/)).toBeNull();
    expect(screen.getByText("Unrealized PnL")).toBeTruthy();
    expect(screen.getByText("Trade Fee")).toBeTruthy();
  });
});
