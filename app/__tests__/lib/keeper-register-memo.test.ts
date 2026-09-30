// @vitest-environment node
/**
 * UX WP-7 (WZ-1/WZ-2): the keeper-registration proof is a memo the creator signs INSIDE the
 * market-creation transaction (no signMessage prompt). SECURITY REVIEW REQUIRED before merge:
 * this replaces the H1v2 signed-message auth of /api/playground/keeper-register.
 *  - M1 (the heaviest config: keeper-priced P3 market, two signers, compute-budget prefix, the memo)
 *    fits a Solana packet (1232 B) — measured here on the exact builder the wizard sends.
 *  - AC3: the route's verifier accepts only (a) a successful tx, (b) the exact memo for THESE
 *    params, (c) signed by the market's creator (InitMarket admin in the same tx, or P3
 *    junior_owner); negative controls for each.
 */
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { deriveMarketParams } from "@/lib/market-params";
import { wizardP3Params } from "@/lib/limits/p3-wizard";
import { buildV17InitMarketArgs, slabSizeFor } from "@/lib/create-market-args";
import { buildM1Instructions } from "@/lib/create-market-m1";
import { buildBatchTx } from "@/lib/tx";
import { KEEPER_REGISTER_MEMO_PREFIX, MEMO_PROGRAM_ID, buildKeeperRegisterMemoIx, keeperRegisterMemoText, verifyKeeperRegisterProofTx } from "@/lib/keeper-register-memo";

const k = () => Keypair.generate().publicKey;
const PARAMS = {
  slabAddress: k().toBase58(),
  dexPoolAddress: k().toBase58(),
  mainnetCA: k().toBase58(),
  dexType: "meteora-dlmm",
  symbol: "LONGSYMBOL",
  label: "A very long human label for the market, as long as the wizard allows it to be",
};

async function m1(memo: boolean, wallet = Keypair.generate(), slab = Keypair.generate()) {
  const derived = deriveMarketParams(10, 1_000_000_000_000n, 1_000_000n);
  const params = { initialPriceE6: 1_000_000n, tradingFeeBps: 30, p3: wizardP3Params(true, 1_000_000_000n, 1000) };
  const programId = k();
  const ixs = buildM1Instructions({
    programId, wallet: wallet.publicKey, slab: slab.publicKey, mint: k(), vaultAta: k(), vaultPda: k(), nftRegistry: k(),
    slabRent: 1_000_000, slabSize: slabSizeFor(params as never), initArgs: buildV17InitMarketArgs(params, derived),
    memo: memo ? await buildKeeperRegisterMemoIx(wallet.publicKey, { ...PARAMS, slabAddress: slab.publicKey.toBase58() }) : null,
  });
  const tx = buildBatchTx({ instructions: ixs, computeUnits: 400_000, priorityFeeMicroLamports: 100_000, blockhash: "11111111111111111111111111111111", feePayer: wallet.publicKey });
  tx.sign(wallet, slab);
  return { tx, ixs, programId, wallet, slab };
}

describe("M1 with the memo fits one packet (heaviest wizard config)", () => {
  it("serialized size <= 1232 B", async () => {
    const without = (await m1(false)).tx.serialize().length;
    const withMemo = (await m1(true)).tx.serialize().length;
    if (process.env.MEASURE_OUT) (await import("node:fs")).writeFileSync(process.env.MEASURE_OUT, `M1 bytes: ${without} without the memo, ${withMemo} with it (limit 1232, headroom ${1232 - withMemo})\n`);
    expect(withMemo).toBeGreaterThan(without);
    expect(withMemo).toBeLessThanOrEqual(1232);
  });
  it("the memo is fixed-length whatever the label / symbol (a hash, not the fields)", async () => {
    const a = await keeperRegisterMemoText(PARAMS);
    const b = await keeperRegisterMemoText({ ...PARAMS, label: "x" });
    expect(a.startsWith(KEEPER_REGISTER_MEMO_PREFIX)).toBe(true);
    expect(a.length).toBe(b.length);
    expect(a).not.toBe(b);
  });
});

/** A landed-tx shape (what connection.getTransaction returns) from a signed legacy tx. */
function landed(tx: Transaction, err: unknown = null) {
  const msg = tx.compileMessage();
  return {
    meta: { err } as never,
    transaction: {
      message: {
        staticAccountKeys: msg.accountKeys,
        header: msg.header,
        compiledInstructions: msg.instructions.map((ix) => ({
          programIdIndex: ix.programIdIndex,
          accountKeyIndexes: ix.accounts,
          data: Buffer.from(bs58.decode(ix.data)),
        })),
      },
    } as never,
  };
}

describe("AC3: the route's verifier", () => {
  it("accepts the creator's M1 (InitMarket admin == memo signer) for exactly these params", async () => {
    const { tx, programId, wallet, slab } = await m1(true);
    const p = { ...PARAMS, slabAddress: slab.publicKey.toBase58() };
    const v = await verifyKeeperRegisterProofTx(landed(tx), p, [programId.toBase58()], null);
    expect(v).toEqual({ ok: true, creator: wallet.publicKey.toBase58(), via: "init-market" });
  });
  it("NEGATIVE: a different pool (repointing) is refused", async () => {
    const { tx, programId, slab } = await m1(true);
    const v = await verifyKeeperRegisterProofTx(landed(tx), { ...PARAMS, slabAddress: slab.publicKey.toBase58(), dexPoolAddress: k().toBase58() }, [programId.toBase58()], null);
    expect(v.ok).toBe(false);
  });
  it("NEGATIVE: a failed tx, an unknown program, a missing memo are refused", async () => {
    const { tx, programId, slab } = await m1(true);
    const p = { ...PARAMS, slabAddress: slab.publicKey.toBase58() };
    expect((await verifyKeeperRegisterProofTx(landed(tx, { InstructionError: [3, { Custom: 1 }] }), p, [programId.toBase58()], null)).ok).toBe(false);
    expect((await verifyKeeperRegisterProofTx(landed(tx), p, [k().toBase58()], null)).ok).toBe(false);
    const bare = await m1(false);
    expect((await verifyKeeperRegisterProofTx(landed(bare.tx), { ...PARAMS, slabAddress: bare.slab.publicKey.toBase58() }, [bare.programId.toBase58()], null)).ok).toBe(false);
    expect((await verifyKeeperRegisterProofTx(null, p, [programId.toBase58()], null)).ok).toBe(false);
  });
  it("NEGATIVE: a stranger's memo tx (not the market's creator) is refused; P3 junior_owner is accepted", async () => {
    const stranger = Keypair.generate();
    const slab = k();
    const p = { ...PARAMS, slabAddress: slab.toBase58() };
    const tx = new Transaction({ feePayer: stranger.publicKey, recentBlockhash: "11111111111111111111111111111111" }).add(await buildKeeperRegisterMemoIx(stranger.publicKey, p));
    tx.sign(stranger);
    expect(await verifyKeeperRegisterProofTx(landed(tx), p, [k().toBase58()], k().toBase58())).toMatchObject({ ok: false });
    expect(await verifyKeeperRegisterProofTx(landed(tx), p, [k().toBase58()], stranger.publicKey.toBase58())).toEqual({ ok: true, creator: stranger.publicKey.toBase58(), via: "junior-owner" });
  });
  it("NEGATIVE: the memo listing a non-signer account is refused", async () => {
    const a = Keypair.generate();
    const b = k();
    const p = { ...PARAMS, slabAddress: k().toBase58() };
    const memo = new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: b, isSigner: false, isWritable: false }], data: Buffer.from(await keeperRegisterMemoText(p)) });
    const tx = new Transaction({ feePayer: a.publicKey, recentBlockhash: "11111111111111111111111111111111" }).add(memo);
    tx.sign(a);
    expect((await verifyKeeperRegisterProofTx(landed(tx), p, [k().toBase58()], b.toBase58())).ok).toBe(false);
  });
});

void PublicKey;
