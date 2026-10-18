/**
 * Double-close safety (audit of #3565). A close is sent as a plain signed TradeCpi size with NO reduce-only flag, and the wrapper only refuses
 * a flip for a same-owner / creator taker (SameOwnerTrade, 67) or clips it on a growth asset (clip_flips_to_close). For any other taker a
 * stale `-closeSize` sent at an already-flat position OPENS an opposite position. So before ANY resend of a close (the transient retry and the
 * EngineStale resend alike) the app checks whether an earlier attempt landed and re-sizes from the LIVE position.
 */
import type { Connection } from "@solana/web3.js";

/** The signature a confirmation-timeout error names ("... Check explorer: <sig>"), or null. */
export function signatureFromError(msg: string): string | null {
  const m = msg.match(/(?:explorer|signature|sig)[:\s]+([1-9A-HJ-NP-Za-km-z]{64,90})\b/i);
  return m ? m[1]! : null;
}

/** True when any of `sigs` is confirmed or finalized without error (history searched). An RPC failure throws: the caller must not resend. */
export async function anySignatureLanded(connection: Pick<Connection, "getSignatureStatuses">, sigs: readonly string[]): Promise<string | null> {
  if (sigs.length === 0) return null;
  const { value } = await connection.getSignatureStatuses([...sigs], { searchTransactionHistory: true });
  for (let i = 0; i < sigs.length; i++) {
    const s = value[i];
    if (s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return sigs[i]!;
  }
  return null;
}

export type RemainingClose =
  | { kind: "done" }
  | { kind: "flipped" }
  | { kind: "send"; closeSize: bigint };

/**
 * What a resend should do given the LIVE effective signed position. `originalCloseSize` is the size computed before the first attempt (its sign
 * says which side was being closed); `intendedFinalAbs` is the |position| the user asked to be left with (0 for a full close).
 */
export function remainingClose(liveSigned: bigint, originalCloseSize: bigint, intendedFinalAbs: bigint): RemainingClose {
  if (liveSigned === 0n) return { kind: "done" };
  const wasLong = originalCloseSize < 0n; // selling closes a long
  if ((liveSigned > 0n) !== wasLong) return { kind: "flipped" };
  const liveAbs = liveSigned < 0n ? -liveSigned : liveSigned;
  const need = liveAbs - intendedFinalAbs;
  if (need <= 0n) return { kind: "done" };
  return { kind: "send", closeSize: wasLong ? -need : need };
}
