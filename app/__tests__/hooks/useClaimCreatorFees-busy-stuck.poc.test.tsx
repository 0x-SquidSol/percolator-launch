/**
 * PoC — rejecting the wallet prompt strands the claim-all button on "claiming…"
 * forever, and because it is `disabled={busy}` there is no way back without a
 * page reload.
 *
 * This file ASSERTS THE BUGGY BEHAVIOUR and passes on `playground`.
 *
 * `claim()` sets `busy` true, then does unguarded work before setting it false:
 *
 *     setBusy(true);                                   // :97
 *     ...
 *     await Promise.all([getFreshBlockhash(), getPriorityFee()]);   // :117  can reject
 *     const outcomes = await runOneApproval(...);                   // :118  can reject
 *     ...
 *     setBusy(false);                                  // :137  never reached on a throw
 *
 * There is no try/finally. `runOneApproval` awaits `signAll` OUTSIDE its own
 * try (one-approval.ts:42 — the catch at :48 only wraps the broadcast loop),
 * and `signAllCompat` returns the wallet promise directly (tx.ts), so a user
 * who declines the signature rejects all the way up into `claim()`.
 *
 * Declining a wallet prompt is not an edge case. It is the single most common
 * thing a user does to a transaction they did not expect.
 */

import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Keypair, TransactionInstruction, type Transaction } from "@solana/web3.js";

const PAYER = Keypair.generate().publicKey;
const PROG = Keypair.generate().publicKey.toBase58();

/** What a wallet does when the user hits Reject. */
class UserRejected extends Error {
  constructor() {
    super("User rejected the request.");
    this.name = "WalletSignTransactionError";
  }
}

let rejectSigning = false;
let failBlockhash = false;
const signAllTransactions = vi.fn(async (txs: Transaction[]) => {
  if (rejectSigning) throw new UserRejected();
  return txs;
});
const WALLET = { publicKey: PAYER, signAllTransactions, signTransaction: vi.fn(async (t: Transaction) => t) };
const CONN = { connection: { getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(8) })) } };

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => WALLET, useConnectionCompat: () => CONN }));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<object>()), getConfig: () => ({ programId: PROG }) }));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: () => undefined }));
vi.mock("@/lib/creator-fee-claim-ix", async (orig) => ({
  ...(await orig<object>()),
  buildCreatorFeeClaimIx: vi.fn(async ({ market }: { market: { toBase58(): string } }) => ({
    instruction: new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [],
      data: Buffer.from(market.toBase58().slice(0, 4)),
    }),
    amount: 1_500_000n,
  })),
}));
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<object>()),
  getFreshBlockhash: async () => {
    // tx.ts getFreshBlockhash(connection, true) awaits connection.getLatestBlockhash()
    // with NO try/catch, so an RPC timeout rejects straight into claim() at :117.
    if (failBlockhash) throw new Error("failed to get latest blockhash: 503 Service Unavailable");
    return "11111111111111111111111111111111";
  },
  getPriorityFee: async () => 1000,
  simulateForGate: async (_c: unknown, _p: unknown, ixs: TransactionInstruction[]) => ({
    err: null,
    consumed: 20_000,
    logs: [],
    rpcFailed: false,
    simulated: ixs,
  }),
  broadcastSignedTx: async () => "sig",
  buildBatchTx: (p: { instructions: TransactionInstruction[]; priorityFeeMicroLamports: number }) => ({
    ixs: p.instructions,
    fee: p.priorityFeeMicroLamports,
  }),
}));

const { useClaimCreatorFees } = await import("@/hooks/useClaimCreatorFees");

/** The reported case: two markets with claimable fees. */
const twoMarkets = [0, 1].map(() => Keypair.generate().publicKey.toBase58());

describe("PoC: a declined wallet prompt strands the claim-all button", () => {
  it("CONTROL: a normal claim finishes and releases the button", async () => {
    // Without this, "busy stayed true" below could just mean the harness never
    // ran the claim at all.
    rejectSigning = false;
    failBlockhash = false;
    const { result } = renderHook(() => useClaimCreatorFees());
    await act(async () => {
      await result.current.claim(twoMarkets);
    });
    expect(result.current.busy).toBe(false);
    expect(signAllTransactions).toHaveBeenCalled();
  });

  it("the claim throws out of the hook instead of being reported", async () => {
    // `claim()` is typed to RESOLVE with per-market outcomes, and the panel
    // awaits it to render per-market errors. A rejection means the caller's
    // `const results = await claim(slabs)` never returns, so no outcome is
    // shown either.
    rejectSigning = true;
    failBlockhash = false;
    const { result } = renderHook(() => useClaimCreatorFees());
    await expect(
      act(async () => {
        await result.current.claim(twoMarkets);
      }),
    ).rejects.toThrow(/rejected/i);
  });

  it("THE DEFECT: busy stays true forever after the rejection", async () => {
    rejectSigning = true;
    failBlockhash = false;
    const { result } = renderHook(() => useClaimCreatorFees());

    await act(async () => {
      await result.current.claim(twoMarkets).catch(() => {});
    });

    // The button reads `busy` for both its label and its disabled state
    // (CreatorFeesPanel.tsx:166,170), so this is literally "claiming…" and
    // un-clickable until the page is reloaded.
    expect(result.current.busy).toBe(true);
  });

  it("and no outcome is recorded, so the panel cannot explain itself either", async () => {
    // `setOutcomes([])` ran on entry and the throw skipped the write-back, so
    // the per-market error list the panel renders is empty. The user sees a
    // stuck spinner and no reason.
    rejectSigning = true;
    failBlockhash = false;
    const { result } = renderHook(() => useClaimCreatorFees());
    await act(async () => {
      await result.current.claim(twoMarkets).catch(() => {});
    });
    expect(result.current.outcomes).toEqual([]);
  });

  it("and reset() does NOT clear it, so there is no recovery path at all", async () => {
    // I assumed the hook's own escape hatch would clear this. It does not:
    // reset() clears `outcomes` and `progress` only (useClaimCreatorFees.ts:143-146).
    // So nothing in the application can return the button to a usable state --
    // not the panel, not the hook. Only a page reload.
    rejectSigning = true;
    failBlockhash = false;
    const { result } = renderHook(() => useClaimCreatorFees());
    await act(async () => {
      await result.current.claim(twoMarkets).catch(() => {});
    });
    expect(result.current.busy).toBe(true);

    act(() => result.current.reset());
    expect(result.current.busy).toBe(true); // still stuck
  });
  it("SECOND TRIGGER: a blockhash RPC blip strands it too, with no wallet involved", async () => {
    // This is why the fix must be a try/finally around the whole body rather
    // than a catch around the signing call: the window at :117 opens BEFORE the
    // wallet is ever asked, and on devnet a getLatestBlockhash timeout is
    // routine. The user never sees a prompt -- the button just sticks.
    failBlockhash = true;
    const { result } = renderHook(() => useClaimCreatorFees());
    await act(async () => {
      await result.current.claim(twoMarkets).catch(() => {});
    });
    expect(signAllTransactions).not.toHaveBeenCalled(); // never got that far
    expect(result.current.busy).toBe(true);
    failBlockhash = false;
  });
});
