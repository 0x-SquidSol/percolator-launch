import { describe, it, expect } from "vitest";
import { earnErrorMessage } from "@/lib/earnErrors";

// Error strings in the shapes the wallet/sendTx path actually produces.
const hex = (n: number) => new Error(`Transaction simulation failed: Error processing Instruction 2: custom program error: 0x${n.toString(16)}`);
const json = (n: number) => new Error(`Transaction failed: {"InstructionError":[1,{"Custom":${n}}]}`);

describe("earnErrorMessage", () => {
  it("Custom(21) on deposit says the vault is locked and nothing was deposited", () => {
    for (const e of [hex(21), json(21)]) {
      const m = earnErrorMessage(e, "deposit");
      expect(m).toMatch(/temporarily locked/i);
      expect(m).toMatch(/Nothing was deposited/);
      expect(m).not.toMatch(/0x15/);
    }
  });

  it("Custom(21) on claim explains the backing is securing open PnL", () => {
    const m = earnErrorMessage(json(21), "claim");
    expect(m).toMatch(/securing traders' open unrealized PnL/);
    expect(m).toMatch(/escrow/);
  });

  it("Custom(19) says the engine is behind", () => {
    expect(earnErrorMessage(hex(19), "deposit")).toMatch(/engine is behind/i);
    expect(earnErrorMessage(hex(19), "claim")).toMatch(/engine is behind/i);
  });

  it("cooldown (36) and OI reservation (37, claim) get Earn copy", () => {
    expect(earnErrorMessage(json(36), "claim")).toMatch(/cooldown/i);
    expect(earnErrorMessage(json(37), "claim")).toMatch(/open interest/i);
  });

  it("NotEnoughAccountKeys is reported as an app-side layout problem, not a user error", () => {
    const m = earnErrorMessage(new Error('Transaction failed: {"InstructionError":[1,"NotEnoughAccountKeys"]}'), "claim");
    expect(m).toMatch(/outdated instruction layout/);
    expect(m).toMatch(/funds have not moved/);
  });

  it("falls back to the generic humanizer for other codes and non-errors", () => {
    expect(earnErrorMessage(json(50), "deposit")).toMatch(/minimum-liquidity/i);
    expect(earnErrorMessage(undefined, "deposit")).toBe("Transaction failed");
  });
});
