/**
 * The engine-crank-stale condition rendered ONE ROW PER MARKET, so on a quiet
 * devnet — where most markets are past the accrue cliff — the creator's whole
 * market list appeared above the real one (#2573). It is one summary line now.
 *
 * See components/my-markets/attentionLogic.ts.
 */

import { describe, expect, it } from "vitest";
import {
  summarizeAffectedMarkets,
  ATTENTION_NAME_CAP,
} from "@/components/my-markets/attentionLogic";

describe("naming the affected markets without becoming a list", () => {
  it("names them all while they fit under the cap", () => {
    expect(summarizeAffectedMarkets(["SOL", "COLLECT"])).toBe("SOL, COLLECT");
  });

  it("collapses the tail into a count once past the cap", () => {
    // THE BUG THIS REPLACES: 6 stale markets rendered 6 rows, duplicating the
    // list. Six names must become one line.
    const names = ["SOL", "COLLECT", "PENGU", "JUP", "BURNIE", "UPTOBER"];
    expect(summarizeAffectedMarkets(names)).toBe("SOL, COLLECT, PENGU, JUP +2 more");
  });

  it("CONTROL: exactly at the cap never reads '+0 more'", () => {
    // The classic off-by-one here. `>` not `>=` is what keeps it honest, and a
    // line reading "+0 more" is the visible symptom of getting it wrong.
    const atCap = Array.from({ length: ATTENTION_NAME_CAP }, (_, i) => `M${i}`);
    const out = summarizeAffectedMarkets(atCap);
    expect(out).not.toContain("more");
    expect(out).toBe(atCap.join(", "));
  });

  it("one over the cap names the cap and counts exactly one", () => {
    const overCap = Array.from({ length: ATTENTION_NAME_CAP + 1 }, (_, i) => `M${i}`);
    expect(summarizeAffectedMarkets(overCap)).toContain("+1 more");
  });

  it("returns an empty string for nothing affected, rather than a phrase", () => {
    // The caller renders no line at all in this case; keeping it empty leaves
    // that decision at the call site instead of inventing "no markets".
    expect(summarizeAffectedMarkets([])).toBe("");
  });

  it("honours an explicit cap", () => {
    expect(summarizeAffectedMarkets(["A", "B", "C"], 1)).toBe("A +2 more");
  });
});
