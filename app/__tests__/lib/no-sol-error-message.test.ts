import { describe, it, expect } from "vitest";
import { humanizeError, NO_SOL_FOR_FEES_MESSAGE } from "@/lib/errorMessages";

describe("no-SOL fee payer gets an actionable message (2026-10-02)", () => {
  it("top-level AccountNotFound (fee payer with 0 SOL) → 'needs a little devnet SOL'", () => {
    expect(humanizeError('Transaction simulation failed: "AccountNotFound"')).toBe(NO_SOL_FOR_FEES_MESSAGE);
    expect(humanizeError('SimulationRefusal: {"err":"AccountNotFound"}')).toBe(NO_SOL_FOR_FEES_MESSAGE);
  });
  it("CONTROL: an AccountNotFound inside an instruction keeps the account wording", () => {
    expect(humanizeError('{"InstructionError":[2,"AccountNotFound"]}')).toMatch(/Account not found on-chain/);
  });
});
