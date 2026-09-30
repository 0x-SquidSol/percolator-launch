// @vitest-environment node
/**
 * Final wrapper (3245e861): CloseResolved reaches 204k CU and 101 SettleVaultLpResolved 285k. The
 * app's budgets must be at least 300k / 400k, and the resolved-exit pre-send simulation must carry
 * the budget (a bare simulation gets the 200k per-instruction default and would read a 285k step as
 * refused).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLEANUP_CU } from "@/lib/limits/own-portfolio-cleanup";

describe("resolved CU budgets", () => {
  it("the exit step tx and the own-portfolio cleanup cover 101 (285k) and CloseResolved (204k)", async () => {
    const { EXIT_TX_CU } = await import("@/hooks/useResolvedExit");
    expect(EXIT_TX_CU).toBeGreaterThanOrEqual(400_000);
    expect(CLEANUP_CU).toBeGreaterThanOrEqual(400_000);
  });
  it("the exit simulation runs under the same budget", () => {
    const src = readFileSync(resolve(process.cwd(), "hooks/useResolvedExit.ts"), "utf8");
    expect(src).toContain("sim.simulate([...computeBudgetPrefix(EXIT_TX_CU), ...ixs])");
    const close = readFileSync(resolve(process.cwd(), "hooks/useCloseMarket.ts"), "utf8");
    expect(close).toMatch(/computeUnits: 600_000/);
  });
});
