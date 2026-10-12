/**
 * v2.2 QA NB-2: sign through the Wallet Standard feature directly so the wallet is TOLD the chain.
 *
 * wallet-adapter's `signTransaction` / `signAllTransactions` call `solana:signTransaction` without a `chain`
 * (@solana/wallet-standard-wallet-adapter-base 1.1.5 adapter.js), which leaves the wallet to guess the cluster of a
 * transaction. The standard input has an optional `chain`; on the v2.2 (devnet-only) build every request names
 * `solana:devnet`. Returns null when the adapter is not a Wallet Standard adapter, has no sign feature, or the
 * connected account does not list devnet: the caller then uses the adapter's own method, unchanged.
 */
import { Transaction, type PublicKey } from "@solana/web3.js";
import { SIGN_CHAIN_DEVNET } from "./sign-guard";

const FEATURE = "solana:signTransaction";
interface StdAccount { address: string; chains: readonly string[]; features: readonly string[] }
interface StdInput { account: StdAccount; transaction: Uint8Array; chain: string }
interface StdWallet {
  accounts: readonly StdAccount[];
  features: Record<string, { signTransaction?: (...inputs: StdInput[]) => Promise<readonly { signedTransaction: Uint8Array }[]> } | undefined>;
}

export type ChainSigner = (txs: Transaction[]) => Promise<Transaction[]>;

export function standardDevnetSigner(adapter: unknown, publicKey: PublicKey | null): ChainSigner | null {
  const a = adapter as { standard?: unknown; wallet?: StdWallet } | null | undefined;
  if (!a || a.standard !== true || !a.wallet || !publicKey) return null;
  const wallet = a.wallet;
  const sign = wallet.features?.[FEATURE]?.signTransaction;
  const account = wallet.accounts?.find((x) => x.address === publicKey.toBase58());
  if (typeof sign !== "function" || !account) return null;
  if (!account.features.includes(FEATURE) || !account.chains.includes(SIGN_CHAIN_DEVNET)) return null;
  return async (txs) => {
    const outputs = await sign.call(
      wallet.features[FEATURE],
      ...txs.map((tx) => ({
        account,
        chain: SIGN_CHAIN_DEVNET,
        transaction: new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false })),
      })),
    );
    if (outputs.length !== txs.length) throw new Error(`Wallet returned ${outputs.length} signed transactions for ${txs.length}`);
    return outputs.map((o) => Transaction.from(o.signedTransaction));
  };
}
