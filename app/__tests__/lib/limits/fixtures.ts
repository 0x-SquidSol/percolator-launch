/** Shared MarketLimits fixtures for the limits tests (not a test file). */
import { PublicKey } from "@solana/web3.js";
import type { MarketLimits } from "@/hooks/useMarketLimits";
import type { LimitsFlags } from "@/lib/limits/flags";

export const ALL_ON: LimitsFlags = { p1: true, p2: true, p2FeeCharged: false, p3: true };
export const OWNER_A = new Uint8Array(32).fill(0xa1);
export const OWNER_LP = new Uint8Array(32).fill(0x1b);

/** $1 asset, 10% IMR (10x), $100 LP flat; kind-2 matcher; P3 vault bound, book crowded long. */
export function marketLimits(over: Partial<MarketLimits> = {}): MarketLimits {
  return {
    state: "ready",
    flags: ALL_ON,
    engine: {
      currentSlot: 505_580_400n,
      mode: 0,
      initialMarginBps: 1_000n,
      maintenanceMarginBps: 500n,
      maxAbsFundingE9PerSlot: 1_000_000n,
      tradeFeeBaseBps: 10n,
      marketId: 1n,
      effectivePriceE6: 1_000_000n,
      oiEffLongQ: 400_000_000n,
      oiEffShortQ: 400_000_000n,
      modeLong: 0,
      modeShort: 0,
    },
    riskLimits: { sideOiCapQ: 0n, lpFloorAtoms: 0n, lpExposureKBps: 0, execBandBps: 0, matcherExtMode: 0, allDefault: true },
    bandBps: 500,
    vaultLp: {
      bound: true,
      vaultLpPortfolio: new Uint8Array(32).fill(7),
      lpNetQ: -400_000_000n,
      levCapQ: 1_000_000_000n,
      lpNetSlot: 505_580_400n,
      skewSlopeE9: 1_000n,
      skewMaxE9: 500n,
      levMaxImrBps: 5_000,
    },
    lp: {
      owner: OWNER_LP,
      capital: 100_000_000n,
      pnl: 0n,
      feeCredits: 0n,
      address: new PublicKey(new Uint8Array(32).fill(7)),
      posQ: -400_000_000n,
    },
    matcher: {
      kind: 2,
      tradingFeeBps: 0,
      baseSpreadBps: 5,
      maxTotalBps: 100,
      impactKBps: 5_000,
      liquidityNotionalE6: 1_000_000_000_000n,
      maxFillAbs: 100_000_000_000n,
      inventoryBase: -400_000_000n,
      maxInventoryAbs: 0n,
      skewSpreadMultBps: 300,
      v2: {
        flags: 1, feeLoBps: 10, feeHiBps: 80, feeColdBps: 10, volAMilli: 1000, volBDen: 100, volAlphaBps: 1000,
        volWarmupLeft: 0, volMoveCap10bps: 100, volRefSlots: 25, thinRebateMultBps: 100, skewCapBps: 100,
        rebateCapBps: 50, maxMarkAgeSlots: 150, observedStaleSlots: 0, boundAssetPlus1: 1,
        skewRefInventory: 1_000_000_000n, volVarE4: 0n, volLastPriceE6: 0n, volLastSlot: 0n,
      },
    },
    vaultState: {
      seniorClaimAtoms: 1_000_000_000n,
      juniorDepositedAtoms: 200_000_000n,
      juniorWithdrawnAtoms: 0n,
      seniorFeeCreditedAtoms: 5_000_000n,
      recalledAtoms: 0n,
      assetIndex: 0,
      juniorFloorBps: 1_000,
      seniorFeeShareBps: 10_000,
      lpPortfolio: new Uint8Array(32).fill(7),
      juniorOwner: OWNER_LP,
    },
    assetAdmin: null,
    ...over,
  };
}
