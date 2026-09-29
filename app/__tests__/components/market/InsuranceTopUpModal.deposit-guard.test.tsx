import { fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deposit: vi.fn(), balance: 3_000_000n as bigint | null }));

vi.mock("gsap", () => ({ default: { fromTo: vi.fn(), to: vi.fn(), set: vi.fn() } }));
vi.mock("@/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: new PublicKey("11111111111111111111111111111111") }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false }));
vi.mock("@/hooks/useInsuranceLP", () => ({
  useInsuranceLP: () => ({
    deposit: mocks.deposit,
    state: { mintExists: true, lpSupply: 0n, insuranceBalance: 0n },
    loading: false,
    error: null,
  }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({ config: { collateralMint: new PublicKey("So11111111111111111111111111111111111111112") } }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ decimals: 6 }) }));
vi.mock("@/hooks/useWalletAtaBalance", () => ({
  useWalletAtaBalance: () => ({ balance: mocks.balance, decimals: 6 }),
}));

import { InsuranceTopUpModal } from "@/components/market/InsuranceTopUpModal";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.balance = 3_000_000n; // wallet holds 3
});

describe("InsuranceTopUpModal wallet-balance guard", () => {
  it("blocks an over-balance top-up (inline error, disabled submit, no deposit call)", () => {
    render(<InsuranceTopUpModal slabAddress="s" currentBalance="0" onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "500" } });
    expect(screen.getByTestId("insurance-topup-amount-error").textContent).toMatch(
      /exceeds your wallet balance \(3 USDC available\)/i,
    );
    const submit = screen.getByRole("button", { name: /top up|deposit|confirm/i, hidden: false }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(mocks.deposit).not.toHaveBeenCalled();
  });

  it("CONTROL: an amount within balance shows no error and enables submit", () => {
    render(<InsuranceTopUpModal slabAddress="s" currentBalance="0" onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "2" } });
    expect(screen.queryByTestId("insurance-topup-amount-error")).toBeNull();
  });
});
