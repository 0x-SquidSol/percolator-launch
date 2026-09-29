/**
 * Order-ticket "Start Trading" starter deposit. Typing an amount above the
 * wallet balance used to be SILENTLY clamped (OrderTicket clamped to the
 * balance, then useInitUser clamped again) — the input kept showing the big
 * number while only the wallet's balance moved. It must now show an inline
 * error, disable the CTA, and never call initUser with the oversized amount.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  initUser: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: mocks.useWalletCompat,
  useConnectionCompat: mocks.useConnectionCompat,
}));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@/hooks/useInitUser", () => ({
  useInitUser: () => ({ initUser: mocks.initUser, loading: false, error: null }),
}));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({
  useTrade: () => ({ trade: vi.fn(), loading: false, error: null }),
  prewarmTradeSubmission: vi.fn(),
}));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => ({ maxFillAbs: null }) }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 1_000_000n }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => null }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({ TradeConfirmationModal: () => null }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useWalletCompat.mockReturnValue({
    publicKey: new PublicKey("11111111111111111111111111111111"),
    connected: true,
  });
  // Wallet holds 12 tokens (6 decimals).
  mocks.useConnectionCompat.mockReturnValue({
    connection: {
      getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: "12000000", decimals: 6 } }),
    },
  });
  mocks.useUserAccount.mockReturnValue(null); // no account yet -> "Start Trading"
  mocks.useSlabState.mockReturnValue({
    accounts: [],
    config: { collateralMint: MINT, decimals: 6 },
    header: null,
    refresh: vi.fn(),
    programId: new PublicKey("11111111111111111111111111111111"),
  });
  mocks.useEngineState.mockReturnValue({
    engine: null,
    params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n },
    insuranceBalance: 0n,
    totalOI: 0n,
    hasData: true,
  });
  mocks.initUser.mockResolvedValue({ sig: "s", depositedAmount: 0n });
});

const field = () => screen.getByLabelText(/starter deposit amount/i) as HTMLInputElement;
const cta = () => screen.getByRole("button", { name: /^start trading$/i }) as HTMLButtonElement;

describe("order-ticket starter deposit vs wallet balance", () => {
  it("prefills within balance and starts trading with exactly that amount", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(field().value).toBe("12")); // CONTROL: balance resolved
    expect(screen.queryByTestId("starter-deposit-error")).toBeNull();
    fireEvent.click(cta());
    await waitFor(() => expect(mocks.initUser).toHaveBeenCalledWith(12_000_000n));
  });

  it("shows an inline error, disables the CTA and never calls initUser when over balance", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(field().value).toBe("12"));
    fireEvent.change(field(), { target: { value: "5000" } });
    expect(screen.getByTestId("starter-deposit-error").textContent).toMatch(
      /exceeds your wallet balance \(12 .* available\)/i,
    );
    expect(cta().disabled).toBe(true);
    fireEvent.click(cta());
    expect(mocks.initUser).not.toHaveBeenCalled();
    // The typed value is NOT silently rewritten.
    expect(field().value).toBe("5000");
  });

  it("Max fills the exact wallet balance and clears the error", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(field().value).toBe("12"));
    fireEvent.change(field(), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: /deposit full wallet balance/i }));
    expect(field().value).toBe("12");
    expect(screen.queryByTestId("starter-deposit-error")).toBeNull();
    expect(cta().disabled).toBe(false);
  });
});
