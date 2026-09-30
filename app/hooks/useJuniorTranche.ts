'use client';

/**
 * Creator's junior (first-loss) tranche on a P3 vault-owned-LP market: top up (96) and withdraw
 * (97). Only the junior owner (the creator who ran InitVaultLp path A, or the owner the
 * protocol named on path B) can sign either; 97 is allowed only while the vault LP is FLAT and
 * above `junior_floor_bps` of the senior claim (the panel shows `withdrawable now`). Builders
 * are lib/limits/p3-ix.ts (executed on real BPF in scripts/limits-parity/p3-sim).
 */
import { useCallback, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { deriveLpBackingLedger, deriveVaultAuthority } from '@percolatorct/sdk';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { useSlabState } from '@/components/providers/SlabProvider';
import { sendTx } from '@/lib/tx';
import { assertDepositWithinBalance, readTokenBalance } from '@/lib/deposit-guard';
import { decodeLpVaultRegistryDomain, decodeVaultLpState } from '@/lib/limits/decode';
import {
  buildDepositJuniorTrancheIx,
  buildWithdrawJuniorTrancheIx,
  deriveLpVaultRegistryPda,
  deriveVaultLpState,
  type VaultLpMarket,
} from '@/lib/limits/p3-ix';

export function useJuniorTranche(slabAddress: string | null) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { programId, config } = useSlabState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const context = useCallback(async () => {
    if (!wallet.publicKey || !slabAddress || !programId || !config) throw new Error('Wallet not connected');
    const prog = new PublicKey(programId);
    const market = new PublicKey(slabAddress);
    const registry = deriveLpVaultRegistryPda(prog, market);
    const vaultLpState = deriveVaultLpState(prog, market);
    const [ri, si] = await connection.getMultipleAccountsInfo([registry, vaultLpState], 'confirmed');
    const st = si && si.owner.equals(prog) ? decodeVaultLpState(new Uint8Array(si.data)) : null;
    if (!st) throw new Error("This market has no vault-owned LP.");
    if (!new PublicKey(st.juniorOwner).equals(wallet.publicKey)) throw new Error('Only the junior owner can move the junior tranche.');
    const domain = ri && ri.owner.equals(prog) ? decodeLpVaultRegistryDomain(new Uint8Array(ri.data)) ?? 0 : 0;
    const vm: VaultLpMarket = {
      programId: prog,
      market,
      registry,
      vaultLpState,
      lpPortfolio: new PublicKey(st.lpPortfolio),
      ledger: deriveLpBackingLedger(prog, market, domain)[0],
      siblingLedger: deriveLpBackingLedger(prog, market, domain ^ 1)[0],
    };
    const [vaultAuthority] = deriveVaultAuthority(prog, market);
    const mint = config.collateralMint;
    return {
      vm,
      owner: wallet.publicKey,
      mint,
      ownerAta: getAssociatedTokenAddressSync(mint, wallet.publicKey),
      vaultToken: getAssociatedTokenAddressSync(mint, vaultAuthority, true),
      vaultAuthority,
    };
  }, [connection, wallet.publicKey, slabAddress, programId, config]);

  const run = useCallback(
    async (kind: 'deposit' | 'withdraw', amount: bigint): Promise<string> => {
      setBusy(true);
      setError(null);
      try {
        if (amount <= 0n) throw new Error('Enter an amount greater than zero.');
        const c = await context();
        const ixs =
          kind === 'deposit'
            ? (assertDepositWithinBalance(amount, await readTokenBalance(connection, c.ownerAta)),
              [buildDepositJuniorTrancheIx(c.vm, c.owner, c.ownerAta, c.vaultToken, amount)])
            : [
                createAssociatedTokenAccountIdempotentInstruction(c.owner, c.ownerAta, c.owner, c.mint),
                buildWithdrawJuniorTrancheIx(c.vm, c.owner, c.ownerAta, c.vaultToken, c.vaultAuthority, amount),
              ];
        return await sendTx({ connection, wallet, instructions: ixs });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [connection, wallet, context],
  );

  return {
    busy,
    error,
    deposit: (amount: bigint) => run('deposit', amount),
    withdraw: (amount: bigint) => run('withdraw', amount),
  };
}
