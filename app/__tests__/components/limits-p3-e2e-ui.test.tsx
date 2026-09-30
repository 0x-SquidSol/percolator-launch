/**
 * Round-4 P3 surfaces: the resolved-exit panel (earn-resolved-exit*) and the P3 wizard panel
 * (limits-wizard-junior-*). Pure views over plans / props; no RPC.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ResolvedExitPanelView } from "@/components/limits/ResolvedExitPanel";
import { WizardTranchePanel } from "@/components/limits/CreatorLimits";
import { __setLimitsFlagsForTest } from "@/lib/limits/flags";
import { COPY } from "@/lib/limits/copy";
import { ALL_ON } from "../lib/limits/fixtures";

vi.mock("@/hooks/useResolvedExit", () => ({ useResolvedExit: () => ({}) }));

afterEach(() => {
  cleanup();
  __setLimitsFlagsForTest(null);
});

const view = (p: Partial<Parameters<typeof ResolvedExitPanelView>[0]>) => (
  <ResolvedExitPanelView plan={null} running={false} lastRun={null} error={null} onRun={() => undefined} canRun {...p} />
);

describe("ResolvedExitPanelView", () => {
  it("renders nothing on a live market", () => {
    const { container } = render(view({ plan: { phase: "not-resolved" } }));
    expect(container.innerHTML).toBe("");
  });
  it("sweep: status + an enabled button that runs the plan", () => {
    const onRun = vi.fn();
    const { getByTestId } = render(view({ onRun, plan: { phase: "sweep", steps: [{ kind: "close-resolved", portfolio: "T" }], blockers: [] } }));
    expect(getByTestId("earn-resolved-exit-panel").dataset.phase).toBe("sweep");
    expect(getByTestId("earn-resolved-exit-status").textContent).toBe(COPY.resolvedExit.sweep(1));
    const b = getByTestId("earn-resolved-exit") as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    fireEvent.click(b);
    expect(onRun).toHaveBeenCalledTimes(1);
  });
  it("owner window: says until which slot; the button only runs the empties", () => {
    const { getByTestId } = render(view({ plan: { phase: "owner-window", untilSlot: 1_400n, steps: [], blockers: [] } }));
    expect(getByTestId("earn-resolved-exit-status").textContent).toContain("slot 1400");
    expect((getByTestId("earn-resolved-exit") as HTMLButtonElement).disabled).toBe(true);
  });
  it("ready: no button, no blockers", () => {
    const { getByTestId, queryByTestId } = render(view({ plan: { phase: "ready", blockers: [] } }));
    expect(queryByTestId("earn-resolved-exit")).toBeNull();
    expect(queryByTestId("earn-resolved-exit-blocker")).toBeNull();
    expect(getByTestId("earn-resolved-exit-status").dataset.phase).toBe("ready");
  });
  it("escrowed / locked blockers and the run result", () => {
    const { getAllByTestId, getByTestId } = render(
      view({
        plan: { phase: "sweep", steps: [], blockers: [{ kind: "escrowed", portfolio: "N" }, { kind: "escrowed", portfolio: "M" }, { kind: "locked", portfolio: "L" }] },
        lastRun: { final: { phase: "sweep", steps: [], blockers: [] }, signatures: ["a", "b"], refused: [{ step: { kind: "close-resolved", portfolio: "X" }, err: "x" }], blockers: [], rounds: 1 },
      }),
    );
    expect(getAllByTestId("earn-resolved-exit-blocker").map((b) => b.textContent)).toEqual([COPY.resolvedExit.escrowed(2), COPY.resolvedExit.locked(1)]);
    expect(getByTestId("earn-resolved-exit-result").textContent).toBe(COPY.resolvedExit.result(2, 1));
  });
  it("disabled without a wallet", () => {
    const { getByTestId } = render(view({ canRun: false, plan: { phase: "sweep", steps: [{ kind: "close-empty", portfolio: "E", isVaultLp: false }], blockers: [] } }));
    expect((getByTestId("earn-resolved-exit") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("WizardTranchePanel (P3 wizard)", () => {
  it("floor choices: current one checked, choices above the 2x-seed max disabled, click sets it", () => {
    __setLimitsFlagsForTest(ALL_ON);
    const onFloor = vi.fn();
    const { getAllByTestId, getByTestId } = render(
      <WizardTranchePanel juniorUnits={1000} initialMarginBps={1000} decimals={6} collateralSymbol="USDC" floorBps={2_000} onFloorChange={onFloor} />,
    );
    const btns = getAllByTestId("limits-wizard-junior-floor") as HTMLButtonElement[];
    expect(btns.map((b) => b.dataset.value)).toEqual(["1000", "2000", "3000", "5000"]);
    expect(btns.find((b) => b.getAttribute("aria-checked") === "true")?.dataset.value).toBe("2000");
    expect(btns.every((b) => !b.disabled)).toBe(true); // junior 1000 vs seed NAV 2000 => max 50%
    fireEvent.click(btns[2]);
    expect(onFloor).toHaveBeenCalledWith(3_000);
    expect(getByTestId("limits-wizard-tranche").dataset.floorBps).toBe("2000");
    expect(getByTestId("limits-wizard-pinned-matcher").textContent).toBe(COPY.p3Wizard.pinned);
  });
  it("kill switch: hidden when NEXT_PUBLIC_LIMITS_P3_WIZARD=0", () => {
    __setLimitsFlagsForTest(ALL_ON);
    vi.stubEnv("NEXT_PUBLIC_LIMITS_P3_WIZARD", "0");
    const { container } = render(<WizardTranchePanel juniorUnits={1000} initialMarginBps={1000} decimals={6} collateralSymbol="USDC" />);
    expect(container.innerHTML).toBe("");
    vi.unstubAllEnvs();
  });
  it("shows the requirement issue when the junior is zero", () => {
    __setLimitsFlagsForTest(ALL_ON);
    const { getByTestId } = render(<WizardTranchePanel juniorUnits={0} initialMarginBps={1000} decimals={6} collateralSymbol="USDC" floorBps={1_000} />);
    expect(getByTestId("limits-wizard-junior-issue").dataset.issue).toBe("junior-zero");
  });
});

describe("JuniorTrancheActionsView (96 / 97)", () => {
  it("top-up needs an amount; withdraw is capped at 'withdrawable now'", async () => {
    const { JuniorTrancheActionsView } = await import("@/components/limits/CreatorLimits");
    const onDeposit = vi.fn();
    const onWithdraw = vi.fn();
    const { getByTestId } = render(
      <JuniorTrancheActionsView withdrawableAtoms={2_000_000n} decimals={6} collateralSymbol="USDC" busy={false} error={null} onDeposit={onDeposit} onWithdraw={onWithdraw} />,
    );
    const dep = getByTestId("limits-junior-deposit") as HTMLButtonElement;
    const wd = getByTestId("limits-junior-withdraw") as HTMLButtonElement;
    expect(dep.disabled).toBe(true);
    fireEvent.change(getByTestId("limits-junior-amount-input"), { target: { value: "3" } });
    expect(dep.disabled).toBe(false);
    expect(wd.disabled).toBe(true); // 3 USDC > 2 USDC withdrawable
    fireEvent.click(dep);
    expect(onDeposit).toHaveBeenCalledWith(3_000_000n);
    fireEvent.change(getByTestId("limits-junior-amount-input"), { target: { value: "1.5" } });
    expect(wd.disabled).toBe(false);
    fireEvent.click(wd);
    expect(onWithdraw).toHaveBeenCalledWith(1_500_000n);
  });
  it("withdraw disabled while the LP has open positions (withdrawable 0) and shows errors", async () => {
    const { JuniorTrancheActionsView } = await import("@/components/limits/CreatorLimits");
    const { getByTestId } = render(
      <JuniorTrancheActionsView withdrawableAtoms={0n} decimals={6} collateralSymbol="USDC" busy={false} error="nope" onDeposit={() => undefined} onWithdraw={() => undefined} />,
    );
    fireEvent.change(getByTestId("limits-junior-amount-input"), { target: { value: "1" } });
    expect((getByTestId("limits-junior-withdraw") as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId("limits-junior-error").textContent).toBe("nope");
  });
});
