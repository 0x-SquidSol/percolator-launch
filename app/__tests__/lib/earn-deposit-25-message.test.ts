import { describe, it, expect } from "vitest";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";

const W = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
const err = (code: number) => new Error(`Transaction simulation failed: Error processing Instruction 4: custom program error: 0x${code.toString(16)}
Program ${W} failed: custom program error: 0x${code.toString(16)}`);

describe("Earn deposit refused with EngineCounterUnderflow (25) — calm message (2026-10-02, OTC)", () => {
  it("earn-deposit: 'Vault is settling' instead of 'Something went wrong'", () => {
    const m = resolveUserMessage(err(WRAPPER_ERR.EngineCounterUnderflow) as never, { surface: "earn-deposit" } as never);
    expect(m.title).toBe("Vault is settling");
    expect(m.body).toMatch(/Nothing was sent/);
  });
  it("CONTROL: earn-withdraw keeps its own message", () => {
    const m = resolveUserMessage(err(WRAPPER_ERR.EngineCounterUnderflow) as never, { surface: "earn-withdraw" } as never);
    expect(m.title).toBe("Can't pay out in full");
  });
});
