/**
 * UX WP-7 (audit §3.15, WZ-1/WZ-2): keeper registration WITHOUT a signMessage prompt.
 *
 * The creator's launch batch carries an SPL Memo in the SAME transaction as the market's
 * InitMarket: `percolator:keeper-register:v1:<sha256(canonical params), base64url>`, signed by the
 * creator. `/api/playground/keeper-register` then verifies, from the landed transaction alone:
 *   1. it succeeded;
 *   2. it contains that exact memo (so the pool / CA / dex type / symbol / label in the request are
 *      the ones the creator signed — a stranger cannot repoint the market to another pool);
 *   3. the memo's signer is the market's creator: an InitMarket for THIS slab in the same tx whose
 *      admin is that signer, or (P3) the vault's on-chain `junior_owner`.
 * No wallet prompt, no replay window, no server nonce; the registration can be retried forever.
 */
import { PublicKey, TransactionInstruction, type VersionedTransactionResponse } from "@solana/web3.js";
import { canonicalizeKeeperRegisterParams, type KeeperRegisterProofParams } from "@/lib/keeper-register-proof";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const KEEPER_REGISTER_MEMO_PREFIX = "percolator:keeper-register:v1:";
/** SDK IX_TAG.InitMarket. */
export const INIT_MARKET_TAG = 0;

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The exact memo text for these registration parameters. SHA-256 via WebCrypto
 * (`globalThis.crypto.subtle`): browser-safe and native in Node 20 (the route), no new dependency.
 */
export async function keeperRegisterMemoText(p: KeeperRegisterProofParams): Promise<string> {
  const data = Uint8Array.from(new TextEncoder().encode(canonicalizeKeeperRegisterParams(p)));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
  return KEEPER_REGISTER_MEMO_PREFIX + b64url(digest);
}

/** The memo instruction (creator = signer), placed in the InitMarket transaction. */
export async function buildKeeperRegisterMemoIx(creator: PublicKey, p: KeeperRegisterProofParams): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: creator, isSigner: true, isWritable: false }],
    data: Buffer.from(await keeperRegisterMemoText(p), "utf8"),
  });
}

export type MemoProofVerdict =
  | { ok: true; creator: string; via: "init-market" | "junior-owner" }
  | { ok: false; reason: string };

/**
 * Verify a landed transaction proves the creator registered exactly these parameters.
 * `programIds`: the percolator wrapper ids this deployment accepts. `juniorOwner`: the P3 vault's
 * on-chain junior owner (base58), when the market has one.
 */
export async function verifyKeeperRegisterProofTx(
  tx: Pick<VersionedTransactionResponse, "meta" | "transaction"> | null,
  p: KeeperRegisterProofParams,
  programIds: readonly string[],
  juniorOwner: string | null,
): Promise<MemoProofVerdict> {
  if (!tx) return { ok: false, reason: "proof transaction not found" };
  if (!tx.meta || tx.meta.err !== null) return { ok: false, reason: "proof transaction did not succeed" };
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const nSigners = msg.header.numRequiredSignatures;
  const expected = await keeperRegisterMemoText(p);
  let memoSigner: string | null = null;
  let initAdmin: string | null = null;
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex];
    if (prog === MEMO_PROGRAM_ID.toBase58()) {
      const text = Buffer.from(ix.data).toString("utf8");
      const signerIdx = ix.accountKeyIndexes[0];
      if (text === expected && signerIdx !== undefined && signerIdx < nSigners) memoSigner = keys[signerIdx];
    } else if (programIds.includes(prog) && ix.data[0] === INIT_MARKET_TAG) {
      const accts = ix.accountKeyIndexes.map((i) => keys[i]);
      // ACCOUNTS_INIT_MARKET: [admin(signer), slab, mint]
      if (accts[1] === p.slabAddress && ix.accountKeyIndexes[0] < nSigners) initAdmin = accts[0];
    }
  }
  if (!memoSigner) return { ok: false, reason: "no matching registration memo signed in the proof transaction" };
  if (initAdmin && initAdmin === memoSigner) return { ok: true, creator: memoSigner, via: "init-market" };
  if (juniorOwner && juniorOwner === memoSigner) return { ok: true, creator: memoSigner, via: "junior-owner" };
  return { ok: false, reason: "the memo's signer is not this market's creator" };
}

/**
 * The params the memo binds, from the exact fields the client POSTs (the route canonicalizes
 * `{ slab, pool, mainnetCA ?? "", dexType ?? "", symbol, label }` from the body the same way).
 */
export function keeperMemoParams(r: { slabAddress: string; dexPoolAddress: string; mainnetCA?: string | null; dexType?: string | null; symbol?: string | null }): KeeperRegisterProofParams {
  return {
    slabAddress: r.slabAddress,
    dexPoolAddress: r.dexPoolAddress,
    mainnetCA: r.mainnetCA ?? "",
    dexType: r.dexType ?? "",
    symbol: r.symbol ?? undefined,
    label: undefined,
  };
}
