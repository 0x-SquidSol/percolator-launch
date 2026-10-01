/**
 * Live devnet slab bytes for the keeper enrollment guard (review M-7), read-only captures in
 * m7-slabs.json. `readySlabFor` re-keys the finished CzKxVxPm market to another slab address (only
 * marketauth depends on the address: it must equal that slab's stake-pool PDA), so route tests
 * with generated slab keys still run the guard over real deployed-layout bytes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { deriveStakePool } from "@percolatorct/sdk";

const raw = JSON.parse(readFileSync(join(__dirname, "m7-slabs.json"), "utf8")) as {
  stakeProgram: string;
  keeper: string;
  accounts: Record<string, { owner: string; dataBase64: string }>;
};

export const M7_STAKE_PROGRAM = raw.stakeProgram;
/** The playground keeper (asset 0 oracle_authority on every keeper-priced market). */
export const M7_KEEPER = raw.keeper;
export const FINISHED_SLAB = "CzKxVxPm9gpt7eyQ3xJKh57EMT6i5bep5Swu9NRcpzCh";
export const UNFINISHED_SLAB = "A9u1KkM9fYDjs7Q6ATCvBaxqK4ncSH7TsyN81awVPcW3";
export const SLAB_9EPM = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";

/** WrapperConfigV16.marketauth: account header (16) + config offset 0. */
export const MARKETAUTH_OFF = 16;
/** MarketGroupV16HeaderAccount.insurance / c_tot (u128), absolute. */
export const INSURANCE_OFF = 16 + 576 + 301;
export const C_TOT_OFF = 16 + 576 + 317;
/** Asset 0 AssetOracleProfileV16: oracle_mode @0, oracle_authority @120. */
export const ORACLE_MODE_OFF = 16 + 576 + 758;
export const ORACLE_AUTHORITY_OFF = ORACLE_MODE_OFF + 120;

export function liveSlab(address: string): Buffer {
  const a = raw.accounts[address];
  if (!a) throw new Error(`no capture for ${address}`);
  return Buffer.from(a.dataBase64, "base64");
}

export function readySlabFor(slab: PublicKey | string): Buffer {
  const b = liveSlab(FINISHED_SLAB);
  const [pda] = deriveStakePool(new PublicKey(slab), new PublicKey(M7_STAKE_PROGRAM));
  pda.toBuffer().copy(b, MARKETAUTH_OFF);
  return b;
}
