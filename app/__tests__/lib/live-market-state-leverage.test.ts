/**
 * Guards the fix for the Supabase-path leverage bug.
 *
 * The deployed markets list (landing "Live Markets" rail + /markets) is served
 * from loadMergedMarketRows, whose stored `max_leverage` column is 10 for EVERY
 * market — the indexer never derived it from the on-chain `initialMarginBps`.
 * That is correct only by coincidence for 1000bps markets and wrong for the rest:
 * at fix time on devnet, SOL was 666bps (15x) and COLLECT 1538bps (7x), yet both
 * displayed "10X".
 *
 * The earlier #2638 `computeMaxLeverage` fix only ran in the on-chain DISCOVERY
 * path (discoveredToApiRow), which the live site never uses (Supabase is
 * configured). The fix enriches `max_leverage` in live-market-state — read off
 * the SAME slab bytes it already fetches for price/OI — and has the registry
 * prefer that live value, falling back to the DB column only on an RPC/parse gap.
 *
 * The derivation itself (leverageFromMarginBps) is unit-tested in
 * market-params.test.ts. parseLiveState needs a full v17 slab buffer to exercise
 * directly (isV17Account + valid offsets at 686), so the WIRING is source-bound
 * here, and the real-world bps→leverage mapping — the offset for which was
 * verified against live devnet accounts — is asserted against the values observed
 * at fix time.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { leverageFromMarginBps } from "@/lib/market-params";

const LMS = fs.readFileSync(
  path.resolve(__dirname, "../../lib/live-market-state.ts"),
  "utf8",
);
const REG = fs.readFileSync(
  path.resolve(__dirname, "../../lib/market-registry.ts"),
  "utf8",
);

describe("live-market-state — max_leverage enrichment (Supabase path)", () => {
  it("parses risk params off the slab and derives maxLeverage", () => {
    expect(LMS).toMatch(/import \{ parseV17RiskParams \} from ["']@\/lib\/v17-engine-config["']/);
    expect(LMS).toMatch(/import \{ leverageFromMarginBps \} from ["']@\/lib\/market-params["']/);
    expect(LMS).toMatch(/parseV17RiskParams\(\s*data\s*,\s*cfg\.tradeFeeBps\s*\)/);
    expect(LMS).toMatch(/leverageFromMarginBps\(Number\(risk\.initialMarginBps\)\)/);
  });

  it("exposes maxLeverage on LiveMarketState and returns it", () => {
    expect(LMS).toMatch(/maxLeverage:\s*number \| null/);
    // maxLeverage is the last field of the returned state object (CRLF-safe).
    expect(LMS).toMatch(/maxLeverage,\s*\};/);
  });

  it("registry prefers the live value, falling back to the DB column", () => {
    expect(REG).toMatch(/max_leverage:\s*live\.maxLeverage \?\? m\.max_leverage/);
  });
});

describe("on-chain initialMarginBps -> display leverage (observed on devnet at fix time)", () => {
  it("maps the real markets correctly", () => {
    expect(leverageFromMarginBps(666)).toBe(15); // SOL — was showing 10X
    expect(leverageFromMarginBps(1000)).toBe(10); // JUP/TRUMP/PENGU/BURNIE — coincidentally correct
    // Engine cap is exactly 10000/bps (margin_requirement ceils notional*bps/1e4),
    // so 1538 bps = 6.50x and 2222 bps = 4.50x. Math.round advertised 7x / 5x —
    // above what the engine (and the OrderTicket slider) will accept.
    expect(leverageFromMarginBps(1538)).toBe(6.5); // COLLECT + 10 others — was showing 10X
    expect(leverageFromMarginBps(2222)).toBe(4.5); // PAID — was showing 10X
    expect(leverageFromMarginBps(2000)).toBe(5); // CATE
  });
});
