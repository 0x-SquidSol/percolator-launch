'use client';

/**
 * Earn senior exit after a market resolves (P3 / F-4): reads the market, its LP-vault registry,
 * the vault-LP state and every portfolio on the market, plans the terminal sweep
 * (lib/limits/resolved-exit.ts) and executes it with the connected wallet as the fee payer
 * (lib/limits/resolved-exit-run.ts). Once the market is terminal-flat the ordinary Earn
 * redemption (76 -> 77) pays out.
 *
 * Reads only while the market is RESOLVED; on a live market the hook is inert (one market read).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { deriveLpBackingLedger, deriveVaultAuthority } from '@percolatorct/sdk';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { useSlabState } from '@/components/providers/SlabProvider';
import { sendTx } from '@/lib/tx';
import { connectionSelfHealDeps } from '@/lib/self-heal';
import { readPortfolioIdentity } from '@/lib/v18-wire';
import { KIND_PORTFOLIO, MARKET_MODE_RESOLVED } from '@/lib/limits/constants';
import {
  decodeLpVaultRegistryBound,
  decodeLpVaultRegistryDomain,
  decodeMarketEngineView,
  decodeResolvedMarket,
  decodeResolvedPortfolio,
  decodeVaultLpState,
} from '@/lib/limits/decode';
import { deriveLpVaultRegistryPda, deriveVaultLpState } from '@/lib/limits/p3-ix';
import { planResolvedExit, type ExitPortfolio, type ResolvedExitPlan } from '@/lib/limits/resolved-exit';
import { exitStepIxs, type ExitIxContext, type ExitPortfolioRef } from '@/lib/limits/resolved-exit-ixs';
import { runResolvedExit, type ResolvedExitRun } from '@/lib/limits/resolved-exit-run';
import { harvestableFeeAtoms } from '@/lib/limits/vault-tranche';

/** Raw account offset of the portfolio's provenance market group (see hooks/useTrade.ts). */
const PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF = 16;
const EXIT_TX_CU = 600_000;

interface Snapshot {
  plan: ResolvedExitPlan;
  ctx: ExitIxContext | null;
}

export interface ResolvedExitState {
  resolved: boolean;
  plan: ResolvedExitPlan | null;
  running: boolean;
  lastRun: ResolvedExitRun | null;
  error: string | null;
}

export function useResolvedExit(slabAddress: string | null) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { programId, config } = useSlabState();
  const [state, setState] = useState<ResolvedExitState>({ resolved: false, plan: null, running: false, lastRun: null, error: null });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const snapshot = useCallback(async (): Promise<Snapshot | null> => {
    if (!slabAddress || !programId || !config) return null;
    const prog = new PublicKey(programId);
    const market = new PublicKey(slabAddress);
    const mi = await connection.getAccountInfo(market, 'confirmed');
    if (!mi) return null;
    const md = new Uint8Array(mi.data);
    const m = decodeResolvedMarket(md);
    if (!m || m.mode !== MARKET_MODE_RESOLVED) return { plan: { phase: 'not-resolved' }, ctx: null };

    const registry = deriveLpVaultRegistryPda(prog, market);
    const vaultLpState = deriveVaultLpState(prog, market);
    const [ri, si, nowSlot, pfs] = await Promise.all([
      connection.getAccountInfo(registry, 'confirmed'),
      connection.getAccountInfo(vaultLpState, 'confirmed'),
      connection.getSlot('confirmed'),
      connection.getProgramAccounts(prog, {
        commitment: 'confirmed',
        filters: [{ memcmp: { offset: PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF, bytes: market.toBase58() } }],
      }),
    ]);
    const rd = ri && ri.owner.equals(prog) ? new Uint8Array(ri.data) : null;
    const bound = rd ? decodeLpVaultRegistryBound(rd) === true : false;
    const domain = rd ? decodeLpVaultRegistryDomain(rd) ?? 0 : 0;
    const st = bound && si && si.owner.equals(prog) ? decodeVaultLpState(new Uint8Array(si.data)) : null;
    const vaultLpKey = st ? new PublicKey(st.lpPortfolio).toBase58() : null;

    const portfolios: ExitPortfolio[] = [];
    const refs = new Map<string, ExitPortfolioRef>();
    for (const { pubkey, account } of pfs) {
      const d = new Uint8Array(account.data);
      if (d[10] !== KIND_PORTFOLIO) continue;
      const view = decodeResolvedPortfolio(d);
      if (!view) continue;
      const owner = new PublicKey(view.owner);
      const key = pubkey.toBase58();
      const isVaultLp = key === vaultLpKey;
      let identity;
      try {
        identity = readPortfolioIdentity(d);
      } catch {
        continue;
      }
      refs.set(key, { owner, ...identity });
      portfolios.push({ key, view, isVaultLp, escrowed: !isVaultLp && !PublicKey.isOnCurve(owner.toBytes()) && !owner.equals(registry) });
    }
    const engine = decodeMarketEngineView(md);
    const plan = planResolvedExit({
      market: m,
      nowSlot: BigInt(nowSlot),
      portfolios,
      boundVault: bound,
      harvestableAtoms: engine ? harvestableFeeAtoms(engine) : null,
    });
    const [vaultAuthority] = deriveVaultAuthority(prog, market);
    const payer = wallet.publicKey ?? market;
    const ctx: ExitIxContext = {
      payer,
      collateralMint: config.collateralMint,
      vaultToken: getAssociatedTokenAddressSync(config.collateralMint, vaultAuthority, true),
      vaultAuthority,
      programId: prog,
      market,
      portfolios: refs,
      vault:
        bound && st
          ? {
              programId: prog,
              market,
              registry,
              vaultLpState,
              lpPortfolio: new PublicKey(st.lpPortfolio),
              ledger: deriveLpBackingLedger(prog, market, domain)[0],
              siblingLedger: deriveLpBackingLedger(prog, market, domain ^ 1)[0],
              juniorOwner: new PublicKey(st.juniorOwner),
              domain,
            }
          : null,
    };
    return { plan, ctx };
  }, [connection, slabAddress, programId, config, wallet.publicKey]);

  const refresh = useCallback(async () => {
    try {
      const s = await snapshot();
      if (!alive.current) return;
      setState((p) => ({ ...p, resolved: !!s && s.plan.phase !== 'not-resolved', plan: s?.plan ?? null, error: null }));
    } catch (e) {
      if (alive.current) setState((p) => ({ ...p, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [snapshot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(async (): Promise<ResolvedExitRun | null> => {
    if (!wallet.publicKey || !slabAddress) throw new Error('Wallet not connected');
    const market = new PublicKey(slabAddress);
    const payer = wallet.publicKey;
    setState((p) => ({ ...p, running: true, error: null }));
    let ctx: ExitIxContext | null = null;
    try {
      const sim = connectionSelfHealDeps(connection, market, payer);
      const result = await runResolvedExit({
        plan: async () => {
          const s = await snapshot();
          ctx = s?.ctx ?? null;
          return s?.plan ?? { phase: 'not-resolved' };
        },
        ixsFor: (step) => {
          if (!ctx) throw new Error('market not loaded');
          return exitStepIxs(step, ctx);
        },
        simulate: async (ixs) => (await sim.simulate(ixs)).err ?? null,
        send: (ixs) => sendTx({ connection, wallet, instructions: ixs, computeUnits: EXIT_TX_CU }),
      });
      if (alive.current) setState((p) => ({ ...p, running: false, lastRun: result, plan: result.final }));
      return result;
    } catch (e) {
      if (alive.current) setState((p) => ({ ...p, running: false, error: e instanceof Error ? e.message : String(e) }));
      throw e;
    }
  }, [connection, wallet, slabAddress, snapshot]);

  return { ...state, refresh, run };
}
