// @vitest-environment node
/**
 * UX WP-4 (audit §3.6, user decisions 2026-09-30): the Earn withdrawal flow, the worse-of
 * pricing every preview uses during a price catch-up, and max_now (88 before it happens).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cooldownPhrase,
  fmtCountdown,
  maxNowAtoms,
  previewWithdrawAtoms,
  sharesForUsdc,
  withdrawFlow,
  worseOfLpValue,
} from "@/lib/limits/earn-withdraw";
import { earnPanelPricing, earnViewFromLimits } from "@/lib/limits/earn";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { A_EFFECTIVE_PRICE, A_RAW_ORACLE_TARGET_PRICE } from "@/lib/limits/constants";
import { marketLimits } from "./fixtures";

describe("the flow: two steps unless the vault's cooldown is 0", () => {
  it("cooldown 0 => one tx [76, 77]; any cooldown => request, then the payout", () => {
    expect(withdrawFlow(0n)).toBe("one-tx");
    expect(withdrawFlow(20n)).toBe("two-step");
    expect(withdrawFlow(150n)).toBe("two-step");
  });
  it("plain time: ~150 slots is 'about a minute'; the countdown is m:ss", () => {
    expect(cooldownPhrase(150n)).toBe("about a minute");
    expect(cooldownPhrase(20n)).toBe("a few seconds");
    expect(cooldownPhrase(1_500n)).toBe("about 10 minutes");
    expect(fmtCountdown(60_000)).toBe("1:00");
    expect(fmtCountdown(7_200)).toBe("0:08");
    expect(fmtCountdown(-5)).toBe("0:00");
  });
});

describe("worse-of pricing during a catch-up (next wrapper rule)", () => {
  const v = { kind: "certified" as const, atoms: 1_000_000_000n };
  it("an LP LONG 400 with the target $0.10 above effective: deposit pays the higher value, withdraw gets the lower", () => {
    // at target the LP is worth 400 × 0.10 = +40 USDC
    expect(worseOfLpValue(v, 400_000_000n, 1_000_000n, 1_100_000n, "deposit")).toEqual({ kind: "certified", atoms: 1_040_000_000n });
    expect(worseOfLpValue(v, 400_000_000n, 1_000_000n, 1_100_000n, "withdraw")).toEqual({ kind: "certified", atoms: 1_000_000_000n });
  });
  it("an LP SHORT 400: the same move is a loss at target, so the withdrawal is priced there", () => {
    expect(worseOfLpValue(v, -400_000_000n, 1_000_000n, 1_100_000n, "withdraw")).toEqual({ kind: "certified", atoms: 960_000_000n });
    expect(worseOfLpValue(v, -400_000_000n, 1_000_000n, 1_100_000n, "deposit")).toEqual({ kind: "certified", atoms: 1_000_000_000n });
  });
  it("no catch-up (target = effective, or unread) and a stale value pass through; never negative", () => {
    expect(worseOfLpValue(v, -400_000_000n, 1_000_000n, 1_000_000n, "withdraw")).toBe(v);
    expect(worseOfLpValue(v, -400_000_000n, 1_000_000n, 0n, "withdraw")).toBe(v);
    expect(worseOfLpValue({ kind: "stale" }, -400_000_000n, 1_000_000n, 2_000_000n, "withdraw")).toEqual({ kind: "stale" });
    expect(worseOfLpValue({ kind: "flat", atoms: 10n }, -400_000_000n, 1_000_000n, 9_000_000n, "withdraw")).toEqual({ kind: "flat", atoms: 0n });
  });

  it("the Earn view: withdraw-side senior < deposit-side senior while the price catches up", () => {
    // the base fixture is an impaired-free vault whose LP is SHORT 400 at $1 (certified 120 USDC)
    const L = marketLimits({ engine: { ...marketLimits().engine!, targetPriceE6: 1_100_000n } as never });
    const L0 = marketLimits({ engine: { ...marketLimits().engine!, targetPriceE6: 1_000_000n } as never });
    const backing = 900_000_000n; // the pots don't cover the 1,000 senior alone: the LP value matters
    const dep = earnViewFromLimits(L, backing, 0n, "deposit")!;
    const wd = earnViewFromLimits(L, backing, 0n, "withdraw")!;
    const flat = earnViewFromLimits(L0, backing, 0n, "withdraw")!;
    expect(wd.vaultValue! < dep.vaultValue!).toBe(true);
    expect(dep.vaultValue).toBe(flat.vaultValue); // a short LP is worth less at target: deposit keeps effective
    expect(flat.vaultValue! - wd.vaultValue!).toBe(40_000_000n);
    const pr = earnPanelPricing(L, backing)!;
    expect(pr.withdrawSeniorValue).toBe(wd.senior);
    expect(pr.depositSeniorValue).toBe(dep.senior);
  });
});

describe("USDC <-> shares at the program's price", () => {
  it("sharesForUsdc floors, never exceeds the held shares; the preview redeems ≤ the typed USDC", () => {
    const total = 1_000_000_000n;
    const senior = 1_050_000_000n; // 1.05 per share
    const s = sharesForUsdc(10_000_000n, total, senior, 5_000_000_000n)!;
    expect(s).toBe(9_523_809n);
    expect(previewWithdrawAtoms(s, total, senior)!).toBeLessThanOrEqual(10_000_000n);
    expect(sharesForUsdc(10_000_000_000n, total, senior, 7n)).toBe(7n);
    expect(sharesForUsdc(10n, total, null, 7n)).toBeNull();
  });
});

describe("max_now: what the vault can pay out before open trades close", () => {
  const base = {
    valuation: "certified" as const, excludesUncrankedFees: false, harvestable: 0n, seniorClaimEff: 1_000_000_000n,
    backingCover: 600_000_000n, vaultValue: 1_100_000_000n, senior: 1_000_000_000n, junior: 100_000_000n, sharePriceE6: 1_000_000n,
    cushionBps: 1000, impaired: false, illiquid: true, juniorFloorAtoms: 100_000_000n, withdrawAtoms: null, withdrawKind: "illiquid" as const,
  };
  it("pots + a recall capped at the LP's value", () => {
    expect(maxNowAtoms(base, 500_000_000n, false)).toBe(1_000_000_000n); // recall 400 fits
    expect(maxNowAtoms(base, 150_000_000n, false)).toBe(750_000_000n); // the LP only holds 150
  });
  it("no recall while a senior draw is pending (D-P3-30); no cap when the pots cover", () => {
    expect(maxNowAtoms(base, 500_000_000n, true)).toBe(600_000_000n);
    expect(maxNowAtoms({ ...base, illiquid: false }, 500_000_000n, false)).toBeNull();
    expect(maxNowAtoms(null, 1n, false)).toBeNull();
  });
});

describe("the target price offset (engine AssetStateV16Account, packed Pod)", () => {
  it("raw_oracle_target_price sits 8 bytes before effective_price (market_id 8 + retired_slot 8 + lifecycle 1)", () => {
    expect(A_RAW_ORACLE_TARGET_PRICE).toBe(17);
    expect(A_EFFECTIVE_PRICE - A_RAW_ORACLE_TARGET_PRICE).toBe(8);
  });
  it("on a live market image, target and effective are the same order of magnitude", () => {
    const fx = JSON.parse(readFileSync(join(process.cwd(), "__tests__/fixtures/CdN8r7FB.freshness.market.json"), "utf8")) as { dataBase64: string };
    const v = decodeMarketEngineView(new Uint8Array(Buffer.from(fx.dataBase64, "base64")))!;
    expect(v.effectivePriceE6).toBeGreaterThan(0n);
    expect(v.targetPriceE6).toBeGreaterThan(0n);
    const r = Number(v.targetPriceE6) / Number(v.effectivePriceE6);
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThan(2);
  });
});
