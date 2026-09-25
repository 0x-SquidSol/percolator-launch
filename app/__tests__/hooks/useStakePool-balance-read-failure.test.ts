/**
 * Pins the CLASSIFICATION half of the balance-flicker fix (#2545).
 *
 * `lib/token-balance.ts` decides what a failed read means, and its own tests
 * cover that decision. Nothing there proves the HOOK routes a read into the
 * right branch — a future edit could put `{ ok: true, absent: true }` in a
 * catch and every token-balance test would still pass while the flicker came
 * straight back. These tests drive the real hook against a connection that
 * throws, which is the bug as reported.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { PublicKey, Keypair } from '@solana/web3.js';

const {
  mockPool, mockVaultAuth, mockDepositPda, mockLpMint, mockVault,
  mockLpAta, mockCollateralAta,
} = vi.hoisted(() => {
  const { Keypair: Kp } = require('@solana/web3.js');
  return {
    mockPool: Kp.generate().publicKey,
    mockVaultAuth: Kp.generate().publicKey,
    mockDepositPda: Kp.generate().publicKey,
    mockLpMint: Kp.generate().publicKey,
    mockVault: Kp.generate().publicKey,
    mockLpAta: Kp.generate().publicKey,
    mockCollateralAta: Kp.generate().publicKey,
  };
});

vi.mock('@/hooks/useWalletCompat', () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));
vi.mock('@/components/providers/SlabProvider', () => ({ useSlabState: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: vi.fn() }));

vi.mock('@percolatorct/sdk', () => {
  const { PublicKey: PK } = require('@solana/web3.js');
  const devnetProgramId = new PK('6aJb1F9CDCVWCNYFwj8aQsVb696YnW6J1FznteHq4Q6k');
  return {
    STAKE_PROGRAM_ID: devnetProgramId,
    STAKE_POOL_SIZE: 384,
    getStakeProgramId: vi.fn().mockReturnValue(devnetProgramId),
    deriveStakePool: vi.fn().mockReturnValue([mockPool, 255]),
    deriveStakeVaultAuth: vi.fn().mockReturnValue([mockVaultAuth, 254]),
    deriveDepositPda: vi.fn().mockReturnValue([mockDepositPda, 253]),
    decodeStakePool: vi.fn().mockReturnValue({
      isInitialized: true, lpMint: mockLpMint, vault: mockVault,
      cooldownSlots: 100n, depositCap: 0n,
    }),
  };
});

// Deterministic ATAs, so a test can fail ONE specific read.
vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddress: vi.fn(async (mint: PublicKey) =>
    mint.equals(mockLpMint) ? mockLpAta : mockCollateralAta),
  unpackMint: vi.fn().mockReturnValue({ supply: 10_000_000n }),
  unpackAccount: vi.fn((pubkey: PublicKey) => {
    if (pubkey.equals(mockCollateralAta)) return { amount: 7_000_000n };
    if (pubkey.equals(mockLpAta)) return { amount: 3_000_000n };
    return { amount: 5_000_000n }; // the pool vault
  }),
}));

import { useStakePool } from '../../hooks/useStakePool';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { useSlabState } from '@/components/providers/SlabProvider';
import { useParams } from 'next/navigation';

const mockWalletPubkey = new PublicKey('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
const mockSlabAddress = Keypair.generate().publicKey.toBase58();
const mockCollateralMint = new PublicKey('So11111111111111111111111111111111111111112');
const STAKE_OWNER = new PublicKey('6aJb1F9CDCVWCNYFwj8aQsVb696YnW6J1FznteHq4Q6k');
const TOKEN_OWNER = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

function buildPoolAccountData(): Buffer {
  // Offsets from the hook's own decodeStakePoolV1 (useStakePool.ts:164-176):
  // lpMint@104, vault@136, cooldownSlots@184, depositCap@192. NOT the offsets
  // in __tests__/hooks/useStakePool.test.ts — that fixture writes lpMint at 65,
  // which decodes to the zero pubkey, so both ATAs derive to the same address.
  const buf = Buffer.alloc(384);
  buf[0] = 1; // isInitialized
  mockLpMint.toBuffer().copy(buf, 104);
  mockVault.toBuffer().copy(buf, 136);
  buf.writeBigUInt64LE(100n, 184); // cooldownSlots
  buf.writeBigUInt64LE(0n, 192);   // depositCap
  return buf;
}

function buildDepositPdaData(): Buffer {
  const buf = Buffer.alloc(152);
  buf[0] = 1; buf[1] = 253;
  mockPool.toBuffer().copy(buf, 8);
  mockWalletPubkey.toBuffer().copy(buf, 40);
  buf.writeBigUInt64LE(50n, 72);
  buf.writeBigUInt64LE(1_000_000n, 80);
  return buf;
}

/** A healthy connection: every account resolves. */
function healthyGetAccountInfo(pubkey: PublicKey) {
  if (pubkey.equals(mockPool)) return { data: buildPoolAccountData(), owner: STAKE_OWNER };
  if (pubkey.equals(mockDepositPda)) return { data: buildDepositPdaData(), owner: STAKE_OWNER };
  return { data: Buffer.alloc(165), owner: TOKEN_OWNER };
}

describe('useStakePool — a failed balance read is not a zero balance', () => {
  let mockConnection: any;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    mockConnection = {
      getAccountInfo: vi.fn(async (pubkey: PublicKey) => healthyGetAccountInfo(pubkey)),
      getSlot: vi.fn().mockResolvedValue(200),
    };
    vi.mocked(useConnectionCompat).mockReturnValue({ connection: mockConnection });
    vi.mocked(useWalletCompat).mockReturnValue({
      publicKey: mockWalletPubkey, connected: true, connecting: false,
      wallet: null, signTransaction: vi.fn(), disconnect: vi.fn(),
    });
    vi.mocked(useSlabState).mockReturnValue({
      config: { collateralMint: mockCollateralMint, vaultPubkey: mockVault },
      programId: new PublicKey('5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf'),
    });
    vi.mocked(useParams).mockReturnValue({ slab: mockSlabAddress });
  });

  afterEach(() => { vi.useRealTimers(); });

  /** Drive one more tick of the hook 10s poll interval. */
  async function nextPoll() {
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  }

  it('keeps the collateral balance when the ATA read throws mid-poll', async () => {
    const { result } = renderHook(() => useStakePool());
    await waitFor(() => expect(result.current.state.poolExists).toBe(true));
    expect(result.current.state.userCollateralBalance).toBe(7_000_000n);

    // THE BUG: the endpoint rate-limits exactly this read on the next poll.
    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(mockCollateralAta)) throw new Error('429 Too Many Requests');
      return healthyGetAccountInfo(pubkey);
    });
    await nextPoll();

    // Pre-fix this rendered `Max: 0 USDC`.
    expect(result.current.state.userCollateralBalance).toBe(7_000_000n);
  });

  it('keeps the LP share balance when that read throws', async () => {
    const { result } = renderHook(() => useStakePool());
    await waitFor(() => expect(result.current.state.poolExists).toBe(true));
    expect(result.current.state.userLpBalance).toBe(3_000_000n);

    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(mockLpAta)) throw new Error('429 Too Many Requests');
      return healthyGetAccountInfo(pubkey);
    });
    await nextPoll();

    expect(result.current.state.userLpBalance).toBe(3_000_000n);
  });

  it('CONTROL: an ATA that is genuinely absent still reports zero', async () => {
    // Distinguishes the fix from "never let the balance decrease". A null
    // account is real evidence of zero and must still be honoured.
    const { result } = renderHook(() => useStakePool());
    await waitFor(() => expect(result.current.state.poolExists).toBe(true));
    expect(result.current.state.userCollateralBalance).toBe(7_000_000n);

    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(mockCollateralAta)) return null;
      return healthyGetAccountInfo(pubkey);
    });
    await nextPoll();

    expect(result.current.state.userCollateralBalance).toBe(0n);
  });

  it('CONTROL: a recovered read overwrites the carried-forward figure', async () => {
    // The carried value must not become sticky once the endpoint recovers.
    const { result } = renderHook(() => useStakePool());
    await waitFor(() => expect(result.current.state.poolExists).toBe(true));

    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(mockCollateralAta)) throw new Error('429 Too Many Requests');
      return healthyGetAccountInfo(pubkey);
    });
    await nextPoll();
    expect(result.current.state.userCollateralBalance).toBe(7_000_000n);

    const { unpackAccount } = await import('@solana/spl-token');
    vi.mocked(unpackAccount).mockImplementation((pubkey: any) =>
      (pubkey.equals(mockCollateralAta) ? { amount: 250n } : { amount: 5_000_000n }) as any);
    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) =>
      healthyGetAccountInfo(pubkey));
    await nextPoll();

    expect(result.current.state.userCollateralBalance).toBe(250n);
  });
});
