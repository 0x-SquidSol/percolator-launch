import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { buildKeeperProofMessage, KEEPER_PROOF_PREFIX } from "@/lib/keeper-proof";

const SLAB = "6Hqn4VoMHjvCb1XWQkpnJ1UE3xAverJezVdk3czvgQxh";
const POOL_A = "CsPuA8jjvHhg6UZSjH4s61E5v339ZjBGinQzbm1Nh1Xc";
const POOL_B = "9NqrXtHxAa-attacker-pool-11111111111111111111";

describe("buildKeeperProofMessage", () => {
  it("binds prefix, slab, POOL, and minute in order", () => {
    expect(buildKeeperProofMessage(SLAB, POOL_A, 42)).toBe(
      `${KEEPER_PROOF_PREFIX}:${SLAB}:${POOL_A}:42`,
    );
  });

  it("produces a DIFFERENT message for a different pool (same slab+minute)", () => {
    expect(buildKeeperProofMessage(SLAB, POOL_A, 42)).not.toBe(
      buildKeeperProofMessage(SLAB, POOL_B, 42),
    );
  });

  it("SEC: a signature over pool A does NOT verify for pool B (replay-repoint blocked)", () => {
    const kp = nacl.sign.keyPair();
    const minute = 27_000_000;
    // Force a plain Uint8Array — nacl rejects Buffer/subclass instances that
    // some TextEncoder polyfills return in the test env.
    const enc = (s: string) => Uint8Array.from(new TextEncoder().encode(s));

    const sig = nacl.sign.detached(
      enc(buildKeeperProofMessage(SLAB, POOL_A, minute)),
      kp.secretKey,
    );

    // Same pool → verifies.
    expect(
      nacl.sign.detached.verify(enc(buildKeeperProofMessage(SLAB, POOL_A, minute)), sig, kp.publicKey),
    ).toBe(true);

    // Attacker replays the captured signature but swaps in their own pool →
    // the reconstructed message differs, so verification fails. Before the
    // pool was bound, this would have passed (message was slab+minute only).
    expect(
      nacl.sign.detached.verify(enc(buildKeeperProofMessage(SLAB, POOL_B, minute)), sig, kp.publicKey),
    ).toBe(false);
  });
});
