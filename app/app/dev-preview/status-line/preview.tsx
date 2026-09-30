"use client";

import { StatusLine } from "@/components/ui/StatusLine";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { resolveDevnetProgramIds } from "@/lib/program-ids";

const W = resolveDevnetProgramIds().wrapper;
const err = (code: number) =>
  Object.assign(new Error(`Transaction simulation failed: {"InstructionError":[2,{"Custom":${code}}]}\nProgram ${W} failed: custom program error: 0x${code.toString(16)}`), {
    name: "SimulationRefusal",
    code,
    programId: W,
    logs: [`Program ${W} invoke [1]`, `Program ${W} failed: custom program error: 0x${code.toString(16)}`],
  });

const CASES = [
  resolveUserMessage(err(WRAPPER_ERR.ExecPriceOutsideOracleBand), { surface: "trade", side: "long", symbol: "SOL", maxNow: "12.5" }),
  resolveUserMessage(err(WRAPPER_ERR.EngineStale), { surface: "trade" }),
  resolveUserMessage(err(WRAPPER_ERR.EngineLockActive), { surface: "trade", health: { adlReduceOnly: true } }),
  resolveUserMessage(err(WRAPPER_ERR.LpFloorHalt), { surface: "trade", side: "long" }),
  resolveUserMessage(err(WRAPPER_ERR.VaultLpSeniorImpaired), { surface: "earn-deposit" }),
  resolveUserMessage(err(WRAPPER_ERR.VaultLpPausedForSeniorDraw), { surface: "creator-stake" }),
  resolveUserMessage(new Error("custom program error: 0x7e7e7e"), { surface: "any" }),
];

export function StatusLinePreview() {
  return (
    <main className="mx-auto max-w-[340px] space-y-3 bg-[var(--bg)] p-4" data-testid="dev-preview">
      <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">StatusLine variants (UX WP-1)</p>
      {CASES.map((m) => (
        <StatusLine key={m.kind + m.variant} message={m} onAction={() => undefined} />
      ))}
    </main>
  );
}
