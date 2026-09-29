// @vitest-environment node
/**
 * P1 F4: CloseSlab can return Ok WITHOUT closing (fee-leg re-book / scan progress).
 * The Reclaim flow (useCloseMarket) re-reads the slab AT the tx's slot and calls
 * CloseSlab again until it is closed (tombstone kind 8, or gone), bounded; it never
 * reports "closed" on a still-open slab. The loop is `closeSlabUntilClosed`
 * (lib/limits/close-slab.ts); the hook injects the send + the pinned read.
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  closeSlabState,
  closeSlabUntilClosed,
  MAX_CLOSE_SLAB_RESENDS,
  type CloseSlabState,
} from "@/lib/limits/close-slab";
import { readCloseSlabStateAfter } from "@/hooks/useCloseMarket";
import { COPY } from "@/lib/limits/copy";

const SLAB = Keypair.generate().publicKey;

describe("closeSlabState", () => {
  it("gone / tombstone => closed; market => still-open; short/other => unknown", () => {
    expect(closeSlabState(null)).toBe("closed");
    const t = new Uint8Array(16);
    t[10] = 8;
    expect(closeSlabState(t)).toBe("closed");
    const m = new Uint8Array(64);
    m[10] = 1;
    expect(closeSlabState(m)).toBe("still-open");
    expect(closeSlabState(new Uint8Array(5))).toBe("unknown");
    const other = new Uint8Array(64);
    other[10] = 3;
    expect(closeSlabState(other)).toBe("unknown");
  });
});

describe("readCloseSlabStateAfter", () => {
  it("pins the read to the tx slot and classifies the bytes", async () => {
    const tomb = Buffer.alloc(16);
    tomb[10] = 8;
    const conn = {
      getSignatureStatuses: vi.fn(async () => ({ value: [{ slot: 901 }] })),
      getAccountInfo: vi.fn(async () => ({ data: tomb })),
    };
    expect(await readCloseSlabStateAfter(conn as never, SLAB, "sig1")).toBe("closed");
    expect(conn.getAccountInfo).toHaveBeenCalledWith(SLAB, { commitment: "confirmed", minContextSlot: 901 });
  });
  it("RPC failure => unknown (never loops on an unreadable state)", async () => {
    const conn = {
      getSignatureStatuses: vi.fn(async () => {
        throw new Error("429");
      }),
      getAccountInfo: vi.fn(),
    };
    expect(await readCloseSlabStateAfter(conn as never, SLAB, "s")).toBe("unknown");
  });
});

function driver(states: CloseSlabState[]) {
  let n = 0;
  const readState = vi.fn(async () => states[Math.min(n, states.length - 1)]);
  const resend = vi.fn(async () => `sig${++n + 1}`);
  return { readState, resend };
}

describe("closeSlabUntilClosed", () => {
  it("re-book on the first send => one re-send, then closed", async () => {
    const d = driver(["still-open", "closed"]);
    const r = await closeSlabUntilClosed({ firstSig: "sig1", ...d, rebookedMessage: COPY.closeRebooked });
    expect(r).toEqual({ signature: "sig2", resends: 1, finalState: "closed" });
    expect(d.resend).toHaveBeenCalledTimes(1);
    expect(d.readState).toHaveBeenNthCalledWith(1, "sig1");
    expect(d.readState).toHaveBeenNthCalledWith(2, "sig2");
  });
  it("closed on the first send => no re-send", async () => {
    const d = driver(["closed"]);
    const r = await closeSlabUntilClosed({ firstSig: "sig1", ...d, rebookedMessage: COPY.closeRebooked });
    expect(r.resends).toBe(0);
    expect(d.resend).not.toHaveBeenCalled();
  });
  it("never closes => bounded re-sends, then throws the re-book message (not success)", async () => {
    const d = driver(["still-open"]);
    await expect(
      closeSlabUntilClosed({ firstSig: "sig1", ...d, rebookedMessage: COPY.closeRebooked }),
    ).rejects.toThrow(COPY.closeRebooked);
    expect(d.resend).toHaveBeenCalledTimes(MAX_CLOSE_SLAB_RESENDS);
  });
  it("unknown read => stop without re-sending", async () => {
    const d = driver(["unknown"]);
    const r = await closeSlabUntilClosed({ firstSig: "sig1", ...d, rebookedMessage: COPY.closeRebooked });
    expect(r).toEqual({ signature: "sig1", resends: 0, finalState: "unknown" });
  });
});
