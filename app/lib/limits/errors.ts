/**
 * Limits error map: P1 wrapper codes 66..71, P3 (provisional, by name),
 * matcher v2 codes 8002..8005 — each mapped ONLY when the failing program is
 * the right one (P0b `failingProgramId` parses `Program <id> failed`). Works on
 * both wallet shapes: Phantom `custom program error: 0x42` and Solflare
 * `{"InstructionError":[n,{"Custom":66}]}` (via the shared extractErrorCode).
 */
import { P2_ERROR_COPY, p3ErrorCopyByCode } from "./copy";
import { P1_ERROR_MESSAGES } from "@/lib/errorMessages";
import { P1_ERR } from "./constants";

export type ErrorOrigin = "wrapper" | "matcher" | "other" | "unknown";

export interface LimitsErrorInput {
  code: number | null;
  /** program id from the failing log line; null when the message has no log (e.g. a bare Solflare JSON). */
  originProgramId: string | null;
  wrapperId: string;
  matcherId: string;
  p3Enabled: boolean;
}

export function originOf(originProgramId: string | null, wrapperId: string, matcherId: string): ErrorOrigin {
  if (!originProgramId) return "unknown";
  if (originProgramId === wrapperId) return "wrapper";
  if (originProgramId === matcherId) return "matcher";
  return "other";
}

/**
 * Copy for a limits error, or null. With an UNKNOWN origin (no program log —
 * Solflare's bare InstructionError JSON), 66..71 are still mapped because no
 * other program in a trade tx uses them (SPL token codes stop at 20, the
 * matcher's are 8000+); 8002..8005 likewise are matcher-only numbers.
 */
export function limitsErrorCopy(i: LimitsErrorInput): string | null {
  if (i.code === null) return null;
  const origin = originOf(i.originProgramId, i.wrapperId, i.matcherId);
  if (origin === "other") return null;
  if (origin !== "matcher" && P1_ERROR_MESSAGES[i.code]) return P1_ERROR_MESSAGES[i.code];
  if (origin !== "matcher" && i.p3Enabled) {
    const p3 = p3ErrorCopyByCode()[i.code];
    if (p3) return p3;
  }
  if (origin !== "wrapper" && P2_ERROR_COPY[i.code]) return P2_ERROR_COPY[i.code];
  return null;
}

/** Is this a P1 "reduce the size" class error (ticket should re-read limits)? */
export function isSizeLimitError(code: number | null): boolean {
  return (
    code === P1_ERR.LpExposureCapExceeded ||
    code === P1_ERR.ProtocolSideOiCapExceeded ||
    code === P1_ERR.ExecPriceOutsideOracleBand ||
    code === P1_ERR.LpFloorHalt
  );
}

/** P3 copy for a wrapper code under the CURRENT provisional ordinals, or null. */
export function p3LimitsErrorCopy(code: number): string | null {
  return p3ErrorCopyByCode()[code] ?? null;
}
