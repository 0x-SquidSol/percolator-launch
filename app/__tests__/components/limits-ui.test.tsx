/**
 * Limits UI render contract (plan §4 data-testids) for every new panel, driven
 * by MarketLimits fixtures (no RPC). Also pins the zero-fill copy:
 * "Market at capacity — no fill", never a success message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The Earn deposit panel renders a connect prompt without a wallet.
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ connected: true, publicKey: null }),
  useConnectionCompat: () => ({ connection: {} }),
}));
import { cleanup, fireEvent, render } from "@testing-library/react";
import { OrderTicketLimits } from "@/components/limits/OrderTicketLimits";
import { MarketLimitsStripView } from "@/components/limits/MarketLimitsStrip";
import { EarnTrancheCardView } from "@/components/limits/EarnTrancheCard";
import { PositionLimitsRow } from "@/components/limits/PositionLimitsRow";
import { CreatorTranchePanelView, WizardTranchePanel } from "@/components/limits/CreatorLimits";
import { deriveTicketLimits } from "@/lib/limits/ticket";
import { earnViewFromLimits } from "@/lib/limits/earn";
import { DepositWithdrawPanel } from "@/components/earn/DepositWithdrawPanel";
import { COPY } from "@/lib/limits/copy";
import { __setLimitsFlagsForTest } from "@/lib/limits/flags";
import { marketLimits, OWNER_A, ALL_ON } from "../lib/limits/fixtures";

afterEach(() => {
  cleanup();
  __setLimitsFlagsForTest(null);
});

const ticketFor = (L = marketLimits(), direction: "long" | "short" = "long", sizeQ = 100_000_000n) =>
  deriveTicketLimits({ limits: L, direction, sizeQ, takerPosQ: 0n, takerOwner: OWNER_A, leverage: 2, limitPriceE6: 0n });

describe("OrderTicketLimits", () => {
  it("renders max size per side with raw q, the reason, and the band", () => {
    const L = marketLimits();
    const { getAllByTestId, getByTestId } = render(
      <OrderTicketLimits limits={L} ticket={ticketFor(L)} direction="long" symbol="SOL" clampedToQ={null} fillResult={null} requestedQ={null} />,
    );
    const rows = getAllByTestId("limits-max-size");
    expect(rows.map((r) => [r.dataset.side, r.dataset.maxQ, r.dataset.state])).toEqual([
      ["long", "600000000", "ready"],
      ["short", "1400000000", "ready"],
    ]);
    expect(getByTestId("limits-max-size-reason").dataset.reason).toBe("lp-exposure");
    expect(getByTestId("limits-band").dataset.bandBps).toBe("500");
  });

  it("zero fill => 'Market at capacity — no fill' (never success)", () => {
    const L = marketLimits();
    const { getByTestId, queryByText } = render(
      <OrderTicketLimits limits={L} ticket={ticketFor(L)} direction="long" symbol="SOL" clampedToQ={null} fillResult={{ kind: "zero", filledQ: 0n }} requestedQ={100n} />,
    );
    const n = getByTestId("limits-fill-result");
    expect(n.dataset.kind).toBe("zero");
    expect(n.textContent).toContain("Market at capacity — no fill");
    expect(queryByText(/success/i)).toBeNull();
  });

  it("halted side + same-owner + clamp + step-down notices carry their testids", () => {
    const L = marketLimits({ lp: { ...marketLimits().lp!, capital: 0n }, assetAdmin: OWNER_A });
    const t = ticketFor(L);
    const { getByTestId } = render(
      <OrderTicketLimits limits={L} ticket={t} direction="long" symbol="SOL" clampedToQ={50_000_000n} fillResult={null} requestedQ={null} />,
    );
    expect(getByTestId("limits-halt-notice").dataset.side).toBe("long");
    expect(getByTestId("limits-same-owner-notice")).toBeTruthy();
    expect(getByTestId("limits-clamp-notice").dataset.maxQ).toBe("50000000");
    expect(getByTestId("limits-stepdown-notice").dataset.maxLeverage).toBe("2");
  });

  it("P2 quote panel: rows, settles-at-mark honesty note", () => {
    const L = marketLimits({ matcher: { ...marketLimits().matcher!, inventoryBase: 0n } });
    const { getByTestId, getAllByTestId } = render(
      <OrderTicketLimits limits={L} ticket={ticketFor(L)} direction="long" symbol="SOL" clampedToQ={null} fillResult={null} requestedQ={null} />,
    );
    expect(getByTestId("limits-quote").dataset.kind).toBe("adaptive");
    const rows = getAllByTestId("limits-quote-row").map((r) => r.dataset.row);
    expect(rows).toEqual(["mark", "quote", "base", "fee-adaptive", "impact", "skew", "band", "settles"]);
    expect(getByTestId("limits-quote").textContent).toContain("settle at the mark price");
  });

  it("renders nothing with all flags off", () => {
    const L = marketLimits({ state: "off" });
    const { container } = render(
      <OrderTicketLimits limits={L} ticket={ticketFor(L)} direction="long" symbol="SOL" clampedToQ={null} fillResult={null} requestedQ={null} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("MarketLimitsStripView", () => {
  it("OI meters, LP health, band, skew", () => {
    const { getAllByTestId, getByTestId } = render(<MarketLimitsStripView limits={marketLimits()} symbol="SOL" />);
    const meters = getAllByTestId("limits-oi-meter");
    expect(meters.map((m) => m.dataset.side)).toEqual(["long", "short"]);
    expect(getByTestId("limits-lp-health").dataset.halted).toBe("false");
    expect(getByTestId("limits-band").dataset.bandBps).toBe("500");
    expect(getByTestId("limits-skew").dataset.skewBps).toBe("-4000");
    expect(getByTestId("limits-skew").textContent).toContain("traders net long");
  });
});

describe("EarnTrancheCardView", () => {
  it("share price, tranche status, APY needs history, disclosure, withdrawal effect", () => {
    const { getByTestId } = render(
      <EarnTrancheCardView
        limits={marketLimits()}
        view={earnViewFromLimits(marketLimits(), 1_000_000_000n, 1_000_000_000n, 100_000_000n)}
        slab="SLAB"
        withdrawShares={100_000_000n}
        decimals={6}
        collateralSymbol="USDC"
        nowSecs={1_700_000_000}
      />,
    );
    const card = getByTestId("limits-tranche-card");
    expect(card.dataset.status).toBe("covered");
    expect(card.dataset.valuation).toBe("certified");
    // C_eff = 1e9 + 2e6 harvestable; senior = C_eff => price 1.002
    expect(getByTestId("limits-share-price").dataset.priceE6).toBe("1002000");
    expect(getByTestId("limits-pending-fees").dataset.excludes).toBe("false");
    expect(getByTestId("limits-junior-value").dataset.valuation).toBe("certified");
    expect(getByTestId("limits-apy").dataset.state).toBe("insufficient-history");
    expect(getByTestId("limits-withdraw-effect").dataset.kind).toBe("normal");
    expect(getByTestId("limits-risk-disclosure").textContent).toContain("senior tranche");
  });
});

describe("EarnTrancheCardView stale valuation", () => {
  it("says 'Needs refresh' instead of guessing when the LP certificate is stale and backing is short", () => {
    const L = marketLimits({ lp: { ...marketLimits().lp!, staleState: 1 } });
    const { getByTestId } = render(
      <EarnTrancheCardView limits={L} view={earnViewFromLimits(L, 900_000_000n, 1_000_000_000n, 0n)} slab="S2" withdrawShares={0n} decimals={6} collateralSymbol="USDC" nowSecs={1} />,
    );
    const card = getByTestId("limits-tranche-card");
    expect(card.dataset.status).toBe("stale");
    expect(card.textContent).toContain("Needs refresh");
    expect(getByTestId("limits-share-price").dataset.priceE6).toBe("");
  });
});

describe("DepositWithdrawPanel deposit gate", () => {
  it("disables Deposit and shows the reason when the program would refuse", () => {
    const { getByTestId } = render(
      <DepositWithdrawPanel
        userBalance={10_000_000n}
        userLpBalance={0n}
        vaultBalance={1n}
        lpSupply={1n}
        vaultAvailable
        decimals={6}
        collateralSymbol="USDC"
        loading={false}
        cooldownElapsed
        onDeposit={async () => {}}
        onWithdraw={async () => {}}
        depositBlockedReason={COPY.depositsPausedImpaired}
        depositBlockKind="senior-impaired"
      />,
    );
    const input = getByTestId("earn-deposit-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    expect((getByTestId("earn-deposit-submit") as HTMLButtonElement).disabled).toBe(true);
    const b = getByTestId("earn-deposit-blocked");
    expect(b.dataset.reason).toBe("senior-impaired");
    expect(b.textContent).toContain("impaired");
  });
  it("control: without a block the same deposit is enabled", () => {
    const { getByTestId, queryByTestId } = render(
      <DepositWithdrawPanel
        userBalance={10_000_000n}
        userLpBalance={0n}
        vaultBalance={1n}
        lpSupply={1n}
        vaultAvailable
        decimals={6}
        collateralSymbol="USDC"
        loading={false}
        cooldownElapsed
        onDeposit={async () => {}}
        onWithdraw={async () => {}}
      />,
    );
    fireEvent.change(getByTestId("earn-deposit-input"), { target: { value: "1" } });
    expect((getByTestId("earn-deposit-submit") as HTMLButtonElement).disabled).toBe(false);
    expect(queryByTestId("earn-deposit-blocked")).toBeNull();
  });
});

describe("Quote panel with the P2 fee channel on", () => {
  it("labels the quote as charged and shows the signed cap", () => {
    const L = marketLimits({
      matcher: { ...marketLimits().matcher!, inventoryBase: 0n },
      riskLimits: { ...marketLimits().riskLimits!, matcherExtMode: 1, maxRequestedFeeBps: 50 },
      engine: { ...marketLimits().engine!, maxTradingFeeBps: 100n },
    });
    const { getAllByTestId, getByTestId } = render(
      <OrderTicketLimits limits={L} ticket={ticketFor(L)} direction="long" symbol="SOL" clampedToQ={null} fillResult={null} requestedQ={null} />,
    );
    const row = getAllByTestId("limits-quote-row").find((r) => r.dataset.row === "fee-charged")!;
    expect(row.textContent).toContain("you sign ≤ 41 bps");
    expect(getByTestId("limits-quote").textContent).toContain("The quoted price is charged");
  });
});

describe("PositionLimitsRow", () => {
  it("a long on a long-crowded book pays skew funding", () => {
    const { getByTestId } = render(
      <PositionLimitsRow limits={marketLimits()} positionQ={100_000_000n} priceE6={1_000_000n} marginAboveMaintAtoms={1_000n} decimals={6} collateralSymbol="USDC" />,
    );
    expect(getByTestId("limits-position-funding").dataset.direction).toBe("pay");
    expect(getByTestId("limits-liq-drift")).toBeTruthy();
  });
  it("a short receives", () => {
    const { getByTestId, queryByTestId } = render(
      <PositionLimitsRow limits={marketLimits()} positionQ={-100_000_000n} priceE6={1_000_000n} marginAboveMaintAtoms={1_000n} decimals={6} collateralSymbol="USDC" />,
    );
    expect(getByTestId("limits-position-funding").dataset.direction).toBe("receive");
    expect(queryByTestId("limits-liq-drift")).toBeNull();
  });
});

describe("Creator panels", () => {
  it("wizard tranche panel (P3 on) / hidden (off)", () => {
    __setLimitsFlagsForTest(ALL_ON);
    const { getByTestId, unmount } = render(<WizardTranchePanel juniorUnits={1000} initialMarginBps={1000} decimals={6} collateralSymbol="USDC" />);
    expect(getByTestId("limits-wizard-tranche").textContent).toContain("Max LP exposure10000 USDC");
    unmount();
    __setLimitsFlagsForTest({ ...ALL_ON, p3: false });
    const { container } = render(<WizardTranchePanel juniorUnits={1000} initialMarginBps={1000} decimals={6} collateralSymbol="USDC" />);
    expect(container.innerHTML).toBe("");
  });
  it("creator tranche panel", () => {
    const { getByTestId } = render(
      <CreatorTranchePanelView limits={marketLimits()} slab="SLAB" backingNavAtoms={1_000_000_000n} totalShares={1_000_000_000n} creatorFeesAtoms={1_234_567n} decimals={6} collateralSymbol="USDC" />,
    );
    const p = getByTestId("limits-creator-tranche");
    expect(p.dataset.market).toBe("SLAB");
    expect(p.textContent).toContain("Junior at risk");
    expect(p.textContent).toContain("LP has open positions");
  });
});
