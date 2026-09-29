/**
 * P1 item 4: a TradeCpi can now return Ok as a ZERO fill (the wrapper clips
 * the request to LP headroom; `size 0` commits the req_id and returns Ok) or
 * a PARTIAL fill. So tx success no longer means "position changed by the
 * requested size" (security review LOW, zero-fill UI coupling). Classify by
 * the MEASURED position delta.
 */
export type FillKind = "full" | "partial" | "zero" | "unknown";

export interface FillResult {
  kind: FillKind;
  /** Signed measured delta (after − before); null when unknown. */
  filledQ: bigint | null;
}

/**
 * `requestedQ` is signed (the taker's requested delta). `afterQ === null`
 * (post-trade read failed) => unknown: the caller must NOT patch local state
 * with the requested size.
 */
export function classifyFill(beforeQ: bigint, afterQ: bigint | null, requestedQ: bigint): FillResult {
  if (afterQ === null || requestedQ === 0n) return { kind: "unknown", filledQ: null };
  const d = afterQ - beforeQ;
  if (d === 0n) return { kind: "zero", filledQ: 0n };
  const sameDir = (d > 0n) === (requestedQ > 0n);
  const absD = d < 0n ? -d : d;
  const absR = requestedQ < 0n ? -requestedQ : requestedQ;
  if (!sameDir) return { kind: "unknown", filledQ: d };
  if (absD >= absR) return { kind: "full", filledQ: d };
  return { kind: "partial", filledQ: d };
}
