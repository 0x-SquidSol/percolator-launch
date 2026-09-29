/**
 * Engine accrual clock (`AssetStateV16Account.slot_last`) and
 * `max_accrual_dt_slots`, read from REAL devnet v18 market bytes.
 *
 * Fixtures were captured read-only with getMultipleAccountsInfoAndContext, so
 * `contextSlot` is the chain slot the bytes were observed at. The live keeper
 * cranks every market every few seconds, so a correct reader must land within
 * a handful of slots of that tip — and must agree with the engine header's own
 * `current_slot` (SDK `parseBackingBucketsV17().headerCurrentSlot`), which the
 * same accrual writes.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { parseBackingBucketsV17, parseWrapperConfigV17 } from "@percolatorct/sdk";
import {
  oraclePushSlotV17,
  readV17AssetSlotLast,
  readV17MaxAccrualDtSlots,
} from "@/lib/v17-engine-clock";

interface MarketFixture {
  market: string;
  contextSlot: number;
  dataBase64: string;
}

function load(name: string): { data: Uint8Array; contextSlot: bigint } {
  const f = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../fixtures/${name}.freshness.market.json`), "utf8"),
  ) as MarketFixture;
  return { data: new Uint8Array(Buffer.from(f.dataBase64, "base64")), contextSlot: BigInt(f.contextSlot) };
}

describe.each(["CdN8r7FB", "Azagguvr"])("v18 engine clock on live bytes (%s)", (name) => {
  const { data, contextSlot } = load(name);

  it("reads max_accrual_dt_slots = 500 (the live accrue cliff)", () => {
    expect(readV17MaxAccrualDtSlots(data)).toBe(500n);
  });

  it("reads slot_last near the chain tip and equal to the header current_slot", () => {
    const slotLast = readV17AssetSlotLast(data);
    expect(slotLast).not.toBeNull();
    const lag = contextSlot - (slotLast as bigint);
    // Live crank lag was 10-20 slots at capture; anything inside the accrue
    // window proves the offset lands on the real field (the v17 512-byte
    // offset reads 0 → null here, i.e. "never cranked").
    expect(lag).toBeGreaterThanOrEqual(0n);
    expect(lag).toBeLessThan(500n);
    expect(slotLast).toBe(parseBackingBucketsV17(data).headerCurrentSlot);
  });
});

describe("oracle push clock on live bytes", () => {
  it("TRUMP (held mark): last_good_oracle_slot is at the tip while mark_ewma_last_slot is ~1.7h old", () => {
    const { data, contextSlot } = load("CdN8r7FB");
    const cfg = parseWrapperConfigV17(data);
    expect(cfg.oracleMode).toBe(3); // AUTH_MARK
    // The premise of the freshness bug, pinned on real bytes:
    expect(contextSlot - cfg.markEwmaLastSlot).toBeGreaterThan(15_000n);
    expect(contextSlot - cfg.lastGoodOracleSlot).toBeLessThan(10n);
    // …and the push clock follows the push, not the price change.
    expect(oraclePushSlotV17(cfg)).toBe(cfg.lastGoodOracleSlot);
  });

  it("SOL (moving mark): both fields agree, push clock unchanged", () => {
    const { data } = load("Azagguvr");
    const cfg = parseWrapperConfigV17(data);
    expect(cfg.oracleMode).toBe(3);
    expect(oraclePushSlotV17(cfg)).toBe(cfg.lastGoodOracleSlot);
    expect(cfg.lastGoodOracleSlot).toBeGreaterThanOrEqual(cfg.markEwmaLastSlot);
  });

  it("modes 2 (EWMA_MARK) and 3 (AUTH_MARK) use last_good_oracle_slot; others keep mark_ewma_last_slot", () => {
    const base = { markEwmaLastSlot: 100n, lastGoodOracleSlot: 900n };
    expect(oraclePushSlotV17({ ...base, oracleMode: 3 })).toBe(900n);
    expect(oraclePushSlotV17({ ...base, oracleMode: 2 })).toBe(900n);
    expect(oraclePushSlotV17({ ...base, oracleMode: 1 })).toBe(100n);
    expect(oraclePushSlotV17({ ...base, oracleMode: 0 })).toBe(100n);
  });

  it("FAIL-CLOSED: a dead keeper advances neither field, so the push clock stays old", () => {
    expect(oraclePushSlotV17({ oracleMode: 3, markEwmaLastSlot: 1_000n, lastGoodOracleSlot: 1_000n })).toBe(1_000n);
    // Missing lastGoodOracleSlot (partial config) falls back to the mark slot, never to "fresh".
    expect(oraclePushSlotV17({ oracleMode: 3, markEwmaLastSlot: 1_000n })).toBe(1_000n);
  });
});
