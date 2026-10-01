/**
 * The Control Room's position-limit line: one plain sentence with the dollar figure the
 * matcher cap encodes (lib/matcher-params.ts), an info tooltip, and a small 0.25x stepper.
 * Above 1.25x the "keeps your liquidity safe" claim is dropped and a calm one-line note
 * states what a 40% move could cost. Under P3 the protocol pins the limit (1x), read-only.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PositionLimit, positionLimitFigures } from "@/components/create/PositionLimit";
import { StepControlRoom } from "@/components/create/StepControlRoom";

describe("positionLimitFigures", () => {
  it("cap = liquidity x multiple; 40% loss; one trade = cap / 4", () => {
    expect(positionLimitFigures(1000, 10_000)).toEqual({ cap: 1000, lossAtMove: 400, perTrade: 250, aboveSafe: false });
    expect(positionLimitFigures(1000, 12_500).aboveSafe).toBe(false);
    expect(positionLimitFigures(1000, 15_000)).toEqual({ cap: 1500, lossAtMove: 600, perTrade: 375, aboveSafe: true });
    expect(positionLimitFigures(Number.NaN, 10_000).cap).toBe(0);
  });
});

describe("PositionLimit", () => {
  it("shows the plain line with the dollar figure at the 1x default", () => {
    render(<PositionLimit liquidity={1000} exposureBps={10_000} onChange={vi.fn()} collateralSymbol="USDC" />);
    const body = screen.getByTestId("position-limit").textContent ?? "";
    expect(body).toMatch(/Largest position one trader can hold:/);
    expect(screen.getByTestId("position-limit-value").textContent).toBe("$1,000");
    expect(body).toMatch(/keeps your liquidity safe if the price moves 40%/);
    expect(screen.queryByTestId("position-limit-note")).toBeNull();
    expect(screen.getByRole("tooltip", { hidden: true }).textContent).toMatch(/Each trade can be up to \$250/);
  });

  it("steps by 0.25x and stops at the bounds", () => {
    const onChange = vi.fn();
    const { rerender } = render(<PositionLimit liquidity={1000} exposureBps={10_000} onChange={onChange} collateralSymbol="USDC" />);
    fireEvent.click(screen.getByLabelText("Raise position limit"));
    expect(onChange).toHaveBeenLastCalledWith(12_500);
    fireEvent.click(screen.getByLabelText("Lower position limit"));
    expect(onChange).toHaveBeenLastCalledWith(7_500);
    rerender(<PositionLimit liquidity={1000} exposureBps={20_000} onChange={onChange} collateralSymbol="USDC" />);
    expect((screen.getByLabelText("Raise position limit") as HTMLButtonElement).disabled).toBe(true);
    rerender(<PositionLimit liquidity={1000} exposureBps={2_500} onChange={onChange} collateralSymbol="USDC" />);
    expect((screen.getByLabelText("Lower position limit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("above 1.25x drops the safety claim and adds one calm note", () => {
    render(<PositionLimit liquidity={1000} exposureBps={15_000} onChange={vi.fn()} collateralSymbol="USDC" />);
    const body = screen.getByTestId("position-limit").textContent ?? "";
    expect(screen.getByTestId("position-limit-value").textContent).toBe("$1,500");
    expect(body).not.toMatch(/keeps your liquidity safe/);
    expect(screen.getByTestId("position-limit-note").textContent).toMatch(/a 40% price move could cost it about \$600/);
    expect(body).not.toMatch(/warning|danger|caution/i);
  });

  it("P3: fixed by the protocol at 1x, no stepper", () => {
    render(<PositionLimit liquidity={1000} exposureBps={20_000} onChange={vi.fn()} collateralSymbol="USDC" fixedByProtocol />);
    expect(screen.getByTestId("position-limit-value").textContent).toBe("$1,000");
    expect(screen.queryByLabelText("Raise position limit")).toBeNull();
  });
});

describe("StepControlRoom renders the position limit from the wizard's state", () => {
  it("passes liquidity and the chosen multiple through", () => {
    const onLpExposureChange = vi.fn();
    render(
      <StepControlRoom
        {...({
          symbol: "TEST", oracleLabel: "Keeper", startPrice: "$1", slabBytes: 1, rentSol: 0.1,
          initialMarginBps: 1000, tradingFeeBps: 10, lpCollateral: "2000", insuranceAmount: "100",
          collateralSymbol: "USDC", seedTotal: 6100, seedBacking: 4000,
          onMarginBpsChange: vi.fn(), onLpCollateralChange: vi.fn(), onInsuranceChange: vi.fn(),
          onLaunch: vi.fn(), onBack: vi.fn(),
          lpExposureBps: 7_500, onLpExposureChange,
        } as never)}
      />,
    );
    expect(screen.getByTestId("position-limit-value").textContent).toBe("$1,500");
    fireEvent.click(screen.getByLabelText("Raise position limit"));
    expect(onLpExposureChange).toHaveBeenCalledWith(10_000);
  });
});
