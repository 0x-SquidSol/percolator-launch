/**
 * GH#2645 (partial, credited to @0x-SquidSol) — AccountsCard row consistency.
 *
 * When collateral covers a position the Liq cell shows margin health ("N% mgn").
 * The row also carried a DISTANCE bar and a Margin column, both driven by
 * liqHealthPct, which defaults to 100 with no liquidation price: a full green
 * bar and "100.0%" beside "200% mgn" — three readouts of one position disagreeing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { AccountKind } from "@percolatorct/sdk";

let account: Record<string, unknown> = {};
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    accounts: [{ idx: 1, account }],
    config: { collateralMint: null, lastEffectivePriceE6: 100_000_000n, invert: false },
    loading: false,
  }),
}));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ params: { maintenanceMarginBps: 500n } }) }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ decimals: 6 }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 100_000_000n }) }));

import { AccountsCard } from "@/components/trade/AccountsCard";

const mk = (capital: bigint) => {
  account = {
    kind: AccountKind.User,
    owner: new PublicKey("11111111111111111111111111111111"),
    positionSize: 1_000_000n, // 1 token = $100 notional at the $100 mark
    entryPrice: 100_000_000n,
    capital,
    pnl: 0n,
  };
};

afterEach(cleanup);

describe("AccountsCard — liq cell, distance bar and Margin column agree", () => {
  it("covered position: shows margin health, no full-green bar, Margin column = same health", () => {
    mk(200_000_000n); // 200% of notional: past the 105% no-liq-price line
    const { container } = render(<AccountsCard />);
    const liq = container.querySelector('[data-liq-kind]');
    expect(liq?.getAttribute("data-liq-kind")).toBe("covered"); // CONTROL: really the covered branch
    expect(liq?.textContent).toBe("200% mgn");
    expect(container.querySelector(".h-1.w-8")).toBeNull();
    expect(container.textContent).toContain("200.0%");
    expect(container.textContent).not.toContain("100.0%");
  });

  it("priced position: keeps its distance bar and shows the price", () => {
    mk(10_000_000n); // 10% of notional: a real liquidation price exists
    const { container } = render(<AccountsCard />);
    const liq = container.querySelector('[data-liq-kind]');
    expect(liq?.getAttribute("data-liq-kind")).toBe("price"); // CONTROL
    expect(container.querySelector(".h-1.w-8")).not.toBeNull();
  });
});
