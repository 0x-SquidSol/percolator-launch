/**
 * GH#2649 follow-up — `hasVault` drives the Earn grid's "hide vault-less markets".
 * It must reflect a SUCCESSFUL registry read, never the `found: false` defaults a
 * failed batched read leaves behind (or one RPC hiccup on a cold start would hide
 * every market). Consistent with #2614: a market whose registry is truly absent
 * is hidden here and still fails closed on its detail page.
 */
import { describe, it, expect } from 'vitest';
import { buildLiveMarkets, type CuratedVaultOnChain } from '@/hooks/useEarnStats';

const live = (slab: string) => ({ slabAddress: slab, symbol: slab, name: slab, mainnetCa: null, row: {} });
const vaults = (found: boolean): Record<string, CuratedVaultOnChain> => ({
  A: { tvlAtoms: 5_000_000n, cooldownSlots: 0n, found: true },
  B: { tvlAtoms: 0n, cooldownSlots: 0n, found },
});

describe('buildLiveMarkets — hasVault', () => {
  it('trusted read: marks found=true as present and found=false as vault-less', () => {
    const m = buildLiveMarkets([live('A'), live('B')], new Set(['A', 'B']), vaults(false));
    expect(m.find((x) => x.slabAddress === 'A')?.hasVault).toBe(true);
    expect(m.find((x) => x.slabAddress === 'B')?.hasVault).toBe(false);
  });

  it('FAILED read: the found:false defaults must not mark anything vault-less', () => {
    const defaults: Record<string, CuratedVaultOnChain> = {
      A: { tvlAtoms: 0n, cooldownSlots: 0n, found: false },
      B: { tvlAtoms: 0n, cooldownSlots: 0n, found: false },
    };
    const m = buildLiveMarkets([live('A'), live('B')], new Set(['A', 'B']), defaults, new Map(), [], {}, false);
    expect(m).toHaveLength(2);
    for (const x of m) expect(x.hasVault).toBeUndefined();
  });
});
