/**
 * GH#2617 — Create Metaplex Token Metadata for the devnet Sim-USDC collateral mint.
 *
 * The playground's shared collateral mint (DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC)
 * is a classic SPL Token mint with NO Metaplex metadata account, so wallets and the
 * app's own on-chain-metadata fallback show it as a raw, unrecognized address. The
 * app's client-side KNOWN_TOKENS overrides (app/lib/tokenMeta.ts, app/hooks/useTokenMeta.ts,
 * app/components/playground/SimUsdcBalance.tsx) already read it as "Sim-USDC" / "USDC"
 * everywhere inside Percolator's own UI — this script fixes the remaining gap: wallet
 * extensions (Phantom/Solflare) and block explorers, which only ever resolve a token's
 * name/logo from the ON-CHAIN Metaplex metadata PDA, never from this app's JS.
 *
 * Creating this PDA is display-only and inert to the protocol:
 *   - it is a SEPARATE account (seeds ["metadata", TOKEN_METADATA_PROGRAM_ID, mint]),
 *     not a reallocation of the mint itself;
 *   - decimals / supply / mint authority / freeze authority are all untouched;
 *   - the Percolator wrapper program reads the collateral mint by address + decimals,
 *     never by metadata, so market state and accounting are unaffected.
 *
 * SAFETY
 *   - Defaults to a DRY RUN: derives the metadata PDA, confirms it does not already
 *     exist, confirms the local keypair is in fact the mint's authority (all read-only
 *     RPC calls), builds the instruction, and PRINTS what it would send — but does NOT
 *     send it.
 *   - Pass --send (or SEND=true) to actually build, sign, and broadcast the transaction.
 *     This is the only invocation that touches chain state. Run it once; running it a
 *     second time is a safe no-op (the PDA-exists check below will refuse to try again).
 *
 * Usage:
 *   npx tsx scripts/create-collateral-metadata.ts                # dry run (default)
 *   npx tsx scripts/create-collateral-metadata.ts --send          # actually sends
 *
 * Environment variables (all optional, override the defaults below):
 *   RPC_URL                 — Solana devnet RPC endpoint
 *   MINT_AUTHORITY_KEYPAIR  — path to the mint authority's keypair JSON
 *   COLLATERAL_MINT         — override the Sim-USDC mint address
 *   METADATA_NAME           — on-chain "name" field   (default: "Sim USDC")
 *   METADATA_SYMBOL         — on-chain "symbol" field (default: "sUSDC")
 *   METADATA_URI            — on-chain "uri" field    (default: the JSON below)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// Same hand-rolled CreateMetadataAccountV3 encoder the app's own devnet-mint flow
// uses (app/app/devnet-mint/devnet-mint-content.tsx / app/lib/mpl-token-metadata-stub.ts)
// — deliberately NOT the @metaplex-foundation/mpl-token-metadata npm package, which
// was removed from this repo to drop a transitive bigint-buffer dependency
// (CVE-2025-3194, no upstream patch). Colocated under scripts/lib/ rather than
// imported from app/lib/ — see that file's header for why (CJS/ESM package.json
// boundary between app/ and scripts/). The on-chain instruction bytes are
// identical either way.
import {
  createCreateMetadataAccountV3Instruction,
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
} from "./lib/mpl-token-metadata-stub";

// ============================================================================
// Config
// ============================================================================

const RPC_URL = process.env.RPC_URL?.trim() || "https://api.devnet.solana.com";

const KEYPAIR_PATH =
  process.env.MINT_AUTHORITY_KEYPAIR?.trim() ||
  path.join(process.env.HOME || "~", ".config/solana/percolator-devnet-mint-authority.json");

// PLAYGROUND.md #15 — the one collateral mint shared across every playground market.
const COLLATERAL_MINT = new PublicKey(
  process.env.COLLATERAL_MINT?.trim() || "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC",
);

// Deliberately NOT "USDC" / the Circle logo — a devnet test token dressed as real
// USDC would mislead people into thinking devnet balances are real funds (same
// impersonation concern class as GH#2466). Matches app/public/token-metadata/*.
const METADATA_NAME = process.env.METADATA_NAME?.trim() || "Sim USDC";
const METADATA_SYMBOL = process.env.METADATA_SYMBOL?.trim() || "sUSDC";
const METADATA_URI =
  process.env.METADATA_URI?.trim() ||
  "https://percolator-playground.vercel.app/token-metadata/sim-usdc.json";
// ^ Served from app/public/token-metadata/sim-usdc.json (+ sim-usdc.svg for the
//   image), added alongside this script. Deploys automatically with the next
//   playground push — confirm it 200s (not 404) BEFORE running this with --send,
//   or wallets will resolve the name but fail to load the logo.

const SEND = process.argv.includes("--send") || process.env.SEND === "true";

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("GH#2617 — Sim-USDC Metaplex metadata creation");
  console.log("================================================");
  console.log(`RPC:          ${RPC_URL}`);
  console.log(`Mint:         ${COLLATERAL_MINT.toBase58()}`);
  console.log(`Keypair path: ${KEYPAIR_PATH}`);
  console.log(`Mode:         ${SEND ? "SEND (will broadcast a transaction)" : "DRY RUN (no transaction sent)"}`);
  console.log("");

  const connection = new Connection(RPC_URL, "confirmed");

  // ---- Load the mint authority keypair -------------------------------------
  if (!fs.existsSync(KEYPAIR_PATH)) {
    throw new Error(`Keypair not found at ${KEYPAIR_PATH}. Set MINT_AUTHORITY_KEYPAIR to override.`);
  }
  const authority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"))),
  );
  console.log(`Loaded keypair: ${authority.publicKey.toBase58()}`);

  // ---- Read-only: confirm this key really is the mint authority ------------
  const mintAccount = await connection.getParsedAccountInfo(COLLATERAL_MINT);
  if (!mintAccount.value || !("parsed" in mintAccount.value.data)) {
    throw new Error("Could not fetch/parse the collateral mint account.");
  }
  const mintInfo = mintAccount.value.data.parsed.info;
  const onChainMintAuthority: string | null = mintInfo.mintAuthority ?? null;
  const decimals: number = mintInfo.decimals;

  console.log(`On-chain mint authority: ${onChainMintAuthority ?? "(none — mint is frozen/renounced)"}`);
  console.log(`On-chain decimals:       ${decimals}`);

  if (!onChainMintAuthority) {
    throw new Error(
      "Mint has no mint authority on-chain (renounced) — metadata can still be created " +
        "by whoever holds update authority, but this script only supports the " +
        "mintAuthority-signs-as-payer path. Aborting.",
    );
  }
  if (onChainMintAuthority !== authority.publicKey.toBase58()) {
    throw new Error(
      `Loaded keypair (${authority.publicKey.toBase58()}) is NOT the on-chain mint ` +
        `authority (${onChainMintAuthority}). Refusing to proceed.`,
    );
  }
  console.log("✓ Loaded keypair matches the on-chain mint authority.\n");

  // ---- Derive + check the metadata PDA (read-only) --------------------------
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), COLLATERAL_MINT.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  );
  console.log(`Metadata PDA: ${metadataPda.toBase58()}`);

  const existing = await connection.getAccountInfo(metadataPda);
  if (existing) {
    console.log("✓ Metadata account already exists — nothing to do. Exiting.");
    return;
  }
  console.log("✓ Metadata account does not exist yet — safe to create.\n");

  // ---- Build the instruction -------------------------------------------------
  console.log("Metadata to write on-chain:");
  console.log(`  name:   ${JSON.stringify(METADATA_NAME)}`);
  console.log(`  symbol: ${JSON.stringify(METADATA_SYMBOL)}`);
  console.log(`  uri:    ${JSON.stringify(METADATA_URI)}`);
  console.log("");

  const ix = createCreateMetadataAccountV3Instruction(
    {
      metadata: metadataPda,
      mint: COLLATERAL_MINT,
      mintAuthority: authority.publicKey,
      payer: authority.publicKey,
      updateAuthority: authority.publicKey,
    },
    {
      createMetadataAccountArgsV3: {
        data: {
          name: METADATA_NAME,
          symbol: METADATA_SYMBOL,
          uri: METADATA_URI,
          sellerFeeBasisPoints: 0,
          creators: null,
          collection: null,
          uses: null,
        },
        isMutable: true,
        collectionDetails: null,
      },
    },
  );

  if (!SEND) {
    console.log("Dry run complete — nothing was sent. Re-run with --send to broadcast.");
    console.log(`  npx tsx scripts/create-collateral-metadata.ts --send`);
    return;
  }

  // ---- Actually send ----------------------------------------------------------
  const tx = new Transaction().add(ix);
  tx.feePayer = authority.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  console.log("Sending transaction...");
  const sig = await sendAndConfirmTransaction(connection, tx, [authority], {
    commitment: "confirmed",
  });
  console.log(`✓ Confirmed: ${sig}`);
  console.log(`  https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  console.log(`  Metadata account: https://explorer.solana.com/address/${metadataPda.toBase58()}?cluster=devnet`);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
