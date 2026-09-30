/**
 * UX WP-10 (audit FA-1, S0): the playground faucet grants SOL from a SERVER wallet, so a new user
 * can pay network fees even when the public devnet airdrop is rate-limited or down (it usually
 * is). Enabled by an env check only: with no `PLAYGROUND_SOL_FAUCET_KEYPAIR` the routes keep their
 * public-airdrop path, unchanged. The key is never exposed; only a transfer is signed.
 * The funded key lives in the Vercel env of `percolator-playground` (set by the human who holds
 * the env); nothing here funds it.
 */
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { confirmServerSignature } from "@/lib/server-rpc";

export const SOL_FAUCET_ENV = "PLAYGROUND_SOL_FAUCET_KEYPAIR";

export interface SolFaucetSigner {
  publicKey: PublicKey;
  sign(tx: Transaction): void;
}

let cached: SolFaucetSigner | null | undefined;

/** null when the env is unset or unreadable (logged server-side, never echoed to a caller). */
export function getSolFaucetSigner(env: NodeJS.ProcessEnv = process.env): SolFaucetSigner | null {
  if (env === process.env && cached !== undefined) return cached;
  const raw = env[SOL_FAUCET_ENV]?.trim();
  let signer: SolFaucetSigner | null = null;
  if (raw) {
    try {
      const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw) as number[]) : bs58.decode(raw);
      if (bytes.length !== 64) throw new Error("expected 64 bytes");
      const kp = Keypair.fromSecretKey(bytes);
      signer = { publicKey: kp.publicKey, sign: (tx) => tx.partialSign(kp) };
    } catch (e) {
      console.error("[server-sol-faucet] SOL faucet key unreadable:", e instanceof Error ? e.message : String(e));
      signer = null;
    }
  }
  if (env === process.env) cached = signer;
  return signer;
}

/** Transfer `lamports` from the server wallet and wait for confirmation. Returns the signature. */
export async function sendServerSol(p: { connection: Connection; signer: SolFaucetSigner; to: PublicKey; lamports: number }): Promise<string> {
  const { blockhash } = await p.connection.getLatestBlockhash("finalized");
  const tx = new Transaction({ feePayer: p.signer.publicKey, recentBlockhash: blockhash }).add(
    SystemProgram.transfer({ fromPubkey: p.signer.publicKey, toPubkey: p.to, lamports: p.lamports }),
  );
  p.signer.sign(tx);
  const sig = await p.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await confirmServerSignature(p.connection, sig, { timeoutMs: 30_000 });
  return sig;
}

/** For tests only. */
export function __resetSolFaucetSignerForTest(): void {
  cached = undefined;
}
