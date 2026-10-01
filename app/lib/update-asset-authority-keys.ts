import { PublicKey, type AccountMeta } from "@solana/web3.js";

/**
 * Account metas for UpdateAssetAuthority (tag 65).
 *
 * The SDK's ACCOUNTS_UPDATE_AUTHORITY marks `newAuthority` as an unconditional
 * signer, but the deployed handler (wrapper 553d76f0,
 * `handle_update_asset_authority`) only requires it to sign when the new key is
 * NON-zero:
 *
 *     expect_signer(current)?;
 *     expect_writable(market_ai)?;
 *     // A non-zero incoming key must co-sign (proves control); burning to 0
 *     // needs only the rotator.
 *     if new_pubkey != [0u8; 32] { expect_signer(new_authority)?; ... }
 *
 * Built straight from the SDK spec, a burn (new key = all zeros, the System
 * Program id) asks for a signature from an address nobody holds: simulation
 * passes (signatures are not verified there) and the wallet then fails with
 * "Missing signature". So for a zero key, account 1 is a plain read-only
 * placeholder. For any other key it stays a required signer, unchanged.
 */
export const ZERO_PUBKEY = new PublicKey(new Uint8Array(32));

export function updateAssetAuthorityKeys(
  currentAuthority: PublicKey,
  newAuthority: PublicKey,
  slab: PublicKey,
): AccountMeta[] {
  const burning = newAuthority.equals(ZERO_PUBKEY);
  return [
    { pubkey: currentAuthority, isSigner: true, isWritable: false },
    { pubkey: newAuthority, isSigner: !burning, isWritable: false },
    { pubkey: slab, isSigner: false, isWritable: true },
  ];
}
