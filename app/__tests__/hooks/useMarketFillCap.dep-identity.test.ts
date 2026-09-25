/**
 * The "LONG capacity left" row flickered on and off on an active market.
 *
 * `useMarketFillCap`'s effect resets its state before refetching:
 *
 *     setCaps(null);
 *     setInventoryBase(null);
 *
 * which is correct on a real market switch — market B must not validate
 * against market A's caps. But the effect depended on the `programId`
 * OBJECT, and SlabProvider rebuilds that object on every slab poll
 * (`programId: owner ?? s.programId`, where `owner` is a fresh PublicKey from
 * each getAccountInfo response). `parseSlab` only short-circuits when the
 * slab bytes are byte-identical, so on a market with any activity the state
 * updates every poll and the identity churns with it.
 *
 * Result: the effect re-ran on a 3s cadence, blanked both values, and
 * refetched. `getMatcherCaps` is served from a process-wide cache so the
 * "Max per trade" row came back almost instantly, while `inventoryBase`
 * needed a fresh network read — so the capacity row was the one that visibly
 * flickered.
 *
 * The repo already has the idiom for this (`programIdStr` in
 * usePositionNft.ts:354 and useUserAccount.ts:66, and the PERC-9204 note in
 * useInsuranceLP.ts:170 about SlabProvider rebuilding `config` every poll).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { PublicKey, Keypair } from "@solana/web3.js";

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: vi.fn() }));
vi.mock("@/lib/matcherCaps", () => ({
  getMatcherCaps: vi.fn(),
  getMatcherInventory: vi.fn(),
}));

import { useMarketFillCap } from "../../hooks/useMarketFillCap";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { getMatcherCaps, getMatcherInventory } from "@/lib/matcherCaps";

const PROGRAM_ID_B58 = "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ";
const SLAB_A = Keypair.generate().publicKey.toBase58();
const SLAB_B = Keypair.generate().publicKey.toBase58();

const CAPS = { maxFillAbs: 1_000_000n, maxInventoryAbs: 5_000_000n };
const INVENTORY = 123_456n;

/** A never-settling promise: pins whatever state the effect left behind. */
const pending = <T,>() => new Promise<T>(() => {});

describe("useMarketFillCap — slab-poll churn must not blank the capacity row", () => {
  const connection = {} as never;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConnectionCompat).mockReturnValue({ connection });
    vi.mocked(getMatcherCaps).mockResolvedValue(CAPS);
    vi.mocked(getMatcherInventory).mockResolvedValue(INVENTORY);
  });

  /** SlabProvider hands out a BRAND NEW PublicKey for the same program. */
  function setProgramId(b58: string) {
    vi.mocked(useSlabState).mockReturnValue({
      programId: new PublicKey(b58),
    } as never);
  }

  async function renderSettled(slab: string) {
    setProgramId(PROGRAM_ID_B58);
    const h = renderHook(({ s }) => useMarketFillCap(s), {
      initialProps: { s: slab },
    });
    await act(async () => {});
    return h;
  }

  it("keeps the capacity value when SlabProvider re-emits the same programId", async () => {
    const { result, rerender } = await renderSettled(SLAB_A);
    expect(result.current?.inventoryBase).toBe(INVENTORY);

    // A slab poll lands: same program, new object. Nothing may resolve after
    // this point, so whatever the effect does is what stays on screen.
    vi.mocked(getMatcherCaps).mockReturnValue(pending());
    vi.mocked(getMatcherInventory).mockReturnValue(pending());
    setProgramId(PROGRAM_ID_B58);
    await act(async () => {
      rerender({ s: SLAB_A });
    });

    // Pre-fix: the effect re-ran, blanked both, and the row unmounted.
    expect(result.current).not.toBeNull();
    expect(result.current?.inventoryBase).toBe(INVENTORY);
  });

  it("does not refetch on a same-value programId re-emit", async () => {
    const { rerender } = await renderSettled(SLAB_A);
    const capsCalls = vi.mocked(getMatcherCaps).mock.calls.length;

    for (let poll = 0; poll < 3; poll++) {
      setProgramId(PROGRAM_ID_B58);
      await act(async () => {
        rerender({ s: SLAB_A });
      });
    }

    // Pre-fix this was capsCalls + 3 — a full re-resolve every slab poll.
    expect(vi.mocked(getMatcherCaps).mock.calls.length).toBe(capsCalls);
  });

  it("CONTROL: a real market switch still resets, so B cannot inherit A", async () => {
    // Load-bearing. The reset exists to stop market B validating against
    // market A's caps; the fix must not turn it into "never reset".
    const { result, rerender } = await renderSettled(SLAB_A);
    expect(result.current?.inventoryBase).toBe(INVENTORY);

    vi.mocked(getMatcherCaps).mockReturnValue(pending());
    vi.mocked(getMatcherInventory).mockReturnValue(pending());
    await act(async () => {
      rerender({ s: SLAB_B });
    });

    expect(result.current).toBeNull();
  });

  it("CONTROL: a genuinely different programId still resets", async () => {
    // The stabilized dependency must track the program's VALUE, not merely
    // drop the dependency.
    const { result, rerender } = await renderSettled(SLAB_A);
    expect(result.current?.inventoryBase).toBe(INVENTORY);

    vi.mocked(getMatcherCaps).mockReturnValue(pending());
    vi.mocked(getMatcherInventory).mockReturnValue(pending());
    setProgramId(Keypair.generate().publicKey.toBase58());
    await act(async () => {
      rerender({ s: SLAB_A });
    });

    expect(result.current).toBeNull();
  });
});
