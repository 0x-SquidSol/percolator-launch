/**
 * GH#2660 — an entry price is shown when it resolved, and never invented.
 *
 * v17 stores no `entry_price`, so `account.entryPrice` is a hard-coded 0n
 * (`userAccountScan.ts:153`: "v17 genuinely does not store one"). The entry is
 * reconstructed by `resolveEntryPrice` into `effectiveEntryPrice` +
 * `entryPriceSource`, and `resolveEntryPrice`'s own doc states the rule every
 * surface has to follow: "only DISPLAY should branch on `source`".
 *
 * Two surfaces broke it in OPPOSITE directions:
 *
 *   - `PositionSummary` read the raw `account.entryPrice`, so the dashboard
 *     rendered "—" on EVERY position while the Liq cell beside it showed a
 *     price computed from the entry that had in fact resolved.
 *   - `PortfolioPositionsView` rendered `effectiveEntryPrice` ungated. On the
 *     "unknown" path that value IS the oracle price, so the row showed the
 *     current mark as the trader's entry — equal to the Mark cell two slots
 *     away, on a row reading 0 PnL.
 *
 * WHY THE FIXTURES MATTER, since this is what let both sit unnoticed. Both
 * surfaces already had render tests, and both built a position that cannot
 * exist: `account: { entryPrice: 100_000_000n }` (v17 never stores one) and
 * `entryPriceSource: "onchain"` (not a member of `EntryPriceSource`). A
 * non-zero raw entry is the single input under which the broken dashboard line
 * behaves correctly. The fixtures here are what `usePortfolio` really emits.
 */

import { render, screen, within, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { AccountKind } from "@percolatorct/sdk";

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
      loading: false,
      totalPnl: 0n,
      totalDeposited: 0n,
      refresh: vi.fn(),
    }),
  };
});
vi.mock("@/hooks/useMultiTokenMeta", () => ({ useMultiTokenMeta: () => new Map() }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ connected: true, publicKey: new PublicKey("11111111111111111111111111111111") }),
}));
vi.mock("@/hooks/useLpPositions", () => ({
  useLpPositions: () => ({ positions: [], totalRedeemable: 0, loading: false, isRefreshing: false, error: null, refresh: vi.fn() }),
}));
vi.mock("@/components/portfolio/LpPositionsPanel", () => ({ LpPositionsPanel: () => <div /> }));
vi.mock("@/hooks/useTraderStats", () => ({ useTraderStats: () => ({ stats: null, loading: false, error: null, refresh: vi.fn() }) }));
vi.mock("@/components/trade/TradeStatsPanel", () => ({ TradeStatsPanel: () => <div /> }));
vi.mock("@/components/ui/ScrollReveal", () => ({ ScrollReveal: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ui/GlowButton", () => ({ GlowButton: ({ children }: { children: React.ReactNode }) => <button>{children}</button> }));
vi.mock("@/components/ui/ShimmerSkeleton", () => ({ ShimmerSkeleton: () => null }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false, getMockPortfolioPositions: () => [] }));

import { PositionSummary } from "@/components/dashboard/PositionSummary";
import { PortfolioPositionsView } from "@/components/portfolio/PortfolioPositionsView";
import { describeEntryPrice, resolveEntryPrice } from "@/lib/trading";
import { computeLiqPrice } from "@percolatorct/sdk";
import { computeLiquidationDistancePct } from "@/lib/liquidation-distance";
import { formatUsdPriceE6 } from "@/lib/format";

/** Renders a price exactly as the components do, so assertions cannot drift. */
const usd = (e6: bigint) => formatUsdPriceE6(e6);

const PK = new PublicKey("11111111111111111111111111111111");

/**
 * FIXTURES ARE DERIVED, NOT TRANSCRIBED.
 *
 * My first version hard-coded `effectiveEntryPrice: 26_500n` and
 * `liquidationPriceE6: 65_124n` with a comment claiming the first was "what the
 * PnL back-solve recovers". Neither was true: from the same raw inputs the
 * resolver returns 20567 and `computeLiqPrice` returns 23896. Two invented
 * numbers that corroborated each other, so nothing looked wrong — and the Liq
 * "control" asserted a constant derivable from nothing, which made it
 * tautological and blind to a real Liq regression.
 *
 * That is precisely the defect this file's preamble complains about in the
 * tests it replaced. So the enriched fields are now COMPUTED here by the same
 * functions `usePortfolio` uses, from raw on-chain-shaped inputs only.
 */
const RAW = {
  size: -12_140_047_588n,   // short, as reported
  capital: 38_400_000n,
  mark: 19_400n,            // $0.019400
  maintenanceMarginBps: 500n,
  initialMarginBps: 1000n,
};

/** Builds a position the way the hook does: resolve, then derive everything. */
function makePosition(opts: { pnl: bigint; cachedEntry?: bigint }) {
  const { size, capital, mark, maintenanceMarginBps, initialMarginBps } = RAW;
  const resolved = resolveEntryPrice(size, opts.cachedEntry ?? 0n, opts.pnl, mark);
  const liquidationPriceE6 = computeLiqPrice(resolved.entry, capital, size, maintenanceMarginBps);
  const liquidationDistancePct = computeLiquidationDistancePct(size, mark, liquidationPriceE6);
  return {
    slabAddress: "Slab111111111111111111111111111111111111111",
    symbol: "COLLECT",
    idx: 0,
    collateralMint: PK,
    market: { slabAddress: PK, config: { collateralMint: PK }, engine: {} },
    effectiveSize: size,
    leverage: 0.5,
    initialMarginBps,
    maintenanceMarginBps,
    oraclePriceE6: mark,
    effectiveEntryPrice: resolved.entry,
    entryPriceSource: resolved.source,
    liquidationPriceE6,
    liquidationDistancePct,
    // "unknown" means the entry is the mark, so PnL computes to a PLACEHOLDER 0.
    unrealizedPnl: resolved.source === "unknown" ? 0n : opts.pnl,
    pnlPercent: resolved.source === "unknown" ? 0 : 36.92,
    account: {
      kind: AccountKind.User, owner: PK,
      positionSize: size, capital, pnl: opts.pnl,
      entryPrice: 0n, // v17: structurally zero, NOT a quirk of this fixture
    },
  };
}

/** A real on-chain PnL, so the entry is BACK-SOLVED. source === "derived". */
const derived = () => makePosition({ pnl: 14_179_575n });
/** A cached entry beats the back-solve. source === "cache". */
const cached = () => makePosition({ pnl: 14_179_575n, cachedEntry: 31_000n });
/** No cache and pnl === 0n: nothing is recoverable. source === "unknown". */
const unresolved = () => makePosition({ pnl: 0n });

afterEach(cleanup);
beforeEach(() => {
  state.positions = [];
});

/** Text of the cell holding a label, scoped so page chrome cannot match. */
function cellFor(label: string): string {
  const el = screen.getAllByText(label)[0]!;
  return (el.parentElement as HTMLElement).textContent ?? "";
}

describe("describeEntryPrice — the shared decision", () => {
  const fmt = (e6: bigint) => `$${(Number(e6) / 1e6).toFixed(6)}`;

  it("shows a resolved entry", () => {
    const d = describeEntryPrice({ entryPriceE6: 26_500n, source: "derived", formatPrice: fmt });
    expect(d.known).toBe(true);
    expect(d.text).toBe("$0.026500");
    expect(d.title).toBeUndefined();
  });

  it("refuses an unknown source even with a positive price", () => {
    // The value IS the mark on this path, so a positive number proves nothing.
    const d = describeEntryPrice({ entryPriceE6: 19_400n, source: "unknown", formatPrice: fmt });
    expect(d.known).toBe(false);
    expect(d.text).toBe("--");
    expect(d.title).toBeTruthy();
  });

  it.each([0n, -1n] as const)("refuses a non-positive entry (%s) even when the source is trusted", (entry) => {
    // UNREACHABLE via resolveEntryPrice, and deliberately asserted anyway.
    // `estimateEntryFromPnl` already clamps (`return entry > 0n ? entry :
    // oraclePrice`), so nothing the resolver emits has a trusted source and a
    // non-positive price. This pins the helper's own contract for callers that
    // build a position by hand — mocks, tests, a future estimator without the
    // clamp — where a confident "$0.000000" would be a fabrication. It is NOT
    // evidence of a live defect, and should not be described as one.
    const d = describeEntryPrice({ entryPriceE6: entry, source: "derived", formatPrice: fmt });
    expect(d.known).toBe(false);
    expect(d.text).toBe("--");
  });

  it("treats a null/undefined entry as unresolved", () => {
    expect(describeEntryPrice({ entryPriceE6: null, source: "cache", formatPrice: fmt }).known).toBe(false);
    expect(describeEntryPrice({ entryPriceE6: undefined, source: "cache", formatPrice: fmt }).known).toBe(false);
  });

  it("honours a caller's unknownText, which is how the em-dash surfaces differ", () => {
    const d = describeEntryPrice({ entryPriceE6: 0n, source: "unknown", formatPrice: fmt, unknownText: "—" });
    expect(d.text).toBe("—");
  });
});

describe("dashboard Overview — PositionSummary", () => {
  it("CONTROL: the card renders the position under test", () => {
    // Without this, every textContent assertion below could pass against an
    // empty DOM for entirely the wrong reason.
    state.positions = [derived()];
    render(<PositionSummary />);
    expect(within(screen.getByRole("link")).getByText(/COLLECT/)).toBeInTheDocument();
  });

  it("CONTROL: the fixtures really do exercise the three sources", () => {
    // The fixtures are derived, so their `source` is an OUTPUT of
    // resolveEntryPrice rather than something asserted into existence. If the
    // resolver's thresholds ever move, the tests below would silently stop
    // testing what they claim to, so pin it here.
    expect(derived().entryPriceSource).toBe("derived");
    expect(cached().entryPriceSource).toBe("cache");
    expect(unresolved().entryPriceSource).toBe("unknown");
    // And the unknown case really is the mark-as-entry trap.
    expect(unresolved().effectiveEntryPrice).toBe(RAW.mark);
  });

  it("shows the recovered entry price, not a dash", () => {
    // THE REGRESSION. Reading account.entryPrice puts a dash here forever.
    const pos = derived();
    state.positions = [pos];
    render(<PositionSummary />);
    expect(cellFor("Entry:")).toContain(usd(pos.effectiveEntryPrice));
  });

  it("shows a cached entry price too", () => {
    // Guards a fix that only handles the "derived" branch.
    const pos = cached();
    state.positions = [pos];
    render(<PositionSummary />);
    expect(cellFor("Entry:")).toContain(usd(pos.effectiveEntryPrice));
    // CONTROL: the cache genuinely won, so this is not just the derived case
    // under another name.
    expect(pos.effectiveEntryPrice).not.toBe(derived().effectiveEntryPrice);
  });

  it("shows a dash — never the mark — when the entry did not resolve", () => {
    // The other direction: with source "unknown", effectiveEntryPrice IS the
    // mark, so a fix that simply swapped the field would print it here.
    state.positions = [unresolved()];
    render(<PositionSummary />);
    const entry = cellFor("Entry:");
    expect(entry).toContain("—");
    expect(entry).not.toContain(usd(RAW.mark));
  });

  it("does not print a confident PnL beside an unresolved entry", () => {
    // `unrealizedPnl` is 0 as a PLACEHOLDER on this path, not a flat reading.
    // PortfolioPosition's own doc: display sites MUST render "--" for it. A
    // green +0 / +0.00% beside an honest dash is the louder half of the lie.
    state.positions = [unresolved()];
    render(<PositionSummary />);
    const card = within(screen.getByRole("link")).getByText(/COLLECT/)
      .closest("a")!.textContent ?? "";
    expect(card).not.toContain("+0.00%");
  });

  it("CONTROL: the Liq cell still shows the price the hook computed", () => {
    // Asserted against the DERIVED value, not a transcribed constant. The
    // earlier version hard-coded a number nothing else could produce, so it
    // echoed the fixture back and could not detect a Liq regression at all.
    const pos = derived();
    state.positions = [pos];
    render(<PositionSummary />);
    expect(pos.liquidationPriceE6).toBeGreaterThan(0n); // CONTROL: there IS one
    expect(cellFor("Liq:")).toContain(usd(pos.liquidationPriceE6));
  });
});

describe("portfolio list — PortfolioPositionsView", () => {
  it("CONTROL: the row renders with both Entry and Mark labels", () => {
    state.positions = [unresolved()];
    render(<PortfolioPositionsView />);
    expect(screen.getAllByText("Entry").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Mark Price").length).toBeGreaterThan(0);
  });

  it("does not present the mark price as the entry price", () => {
    // THE REGRESSION. Rendering effectiveEntryPrice ungated makes Entry and
    // Mark Price the same number on a row whose PnL reads 0.
    state.positions = [unresolved()];
    render(<PortfolioPositionsView />);
    const entry = cellFor("Entry");
    expect(entry).not.toContain(usd(RAW.mark));
    // Em dash, matching this card's own Mark and Liq cells. The "--" spelling
    // belongs to the trade tables, which pair it with an InfoIcon.
    expect(entry).toContain("—");
    // CONTROL: the mark itself still renders, so the assertion above is about
    // the Entry cell and not a row that failed to draw any prices.
    expect(cellFor("Mark Price")).toContain(usd(RAW.mark));
  });

  it("shows a resolved entry when there is one", () => {
    // Guards over-correction — a gate that always rendered a dash would
    // satisfy the test above.
    const pos = derived();
    state.positions = [pos];
    render(<PortfolioPositionsView />);
    expect(cellFor("Entry")).toContain(usd(pos.effectiveEntryPrice));
  });

  it("does not print a live fabricated PnL beside an unresolved entry", () => {
    // Worse here than on the dashboard: the row feeds the POLLED mark in as the
    // entry and compares it to the LIVE mark, so the PnL renders the drift
    // since the last poll — a nonzero, ticking number next to a dash.
    state.positions = [unresolved()];
    render(<PortfolioPositionsView />);
    expect(cellFor("Entry")).toContain("—");
    expect(screen.queryByText("+0.00%")).toBeNull();
  });
});
