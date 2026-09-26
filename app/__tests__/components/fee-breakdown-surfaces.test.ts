/**
 * Binds the fee breakdown to the surfaces that need it.
 *
 * `__tests__/lib/fee-breakdown.test.ts` covers the numbers. It cannot see
 * whether anyone renders them — and "the numbers exist and reach no user" was
 * the entire issue (#2565), so the wiring IS the fix. Reverting all four
 * surfaces leaves that suite green.
 *
 * Same technique, and the same reason, as create-market-launch-gate.test.ts.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const read = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, "../../", rel), "utf8");

/** Strip comments: these assert what is RENDERED, not what is explained. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CREATE = read("components/create/StepControlRoom.tsx");
const EARN = read("components/earn/EarnHeader.tsx");
const STAKE = read("app/stake/page.tsx");
const TICKET = read("components/trade/OrderTicket.tsx");

describe("every audience is shown where the fee goes", () => {
  it.each([
    ["creator (create page)", CREATE, /highlight="creator"/],
    ["LP (Earn)", EARN, /highlight="lp"/],
    ["staker (Stake)", STAKE, /highlight="staker"/],
  ])("%s", (_name, src, marker) => {
    expect(code(src)).toContain("<FeeBreakdown");
    expect(code(src)).toMatch(marker);
  });

  it("the staker surface renders the 0% row explicitly", () => {
    // The row exists to sit next to the 16% insurance share it is mistaken
    // for. Omitting it leaves the original ambiguity intact.
    expect(code(STAKE)).toMatch(/showStaker/);
  });

  it("the trader sees the destination of the fee they pay", () => {
    // The order ticket already showed the amount; it said nothing about where
    // it lands.
    expect(code(TICKET)).toContain("feeDestinationTitle");
    expect(code(TICKET)).toContain("splitFeeAtoms(");
  });
});

describe("no surface restates a share as a literal", () => {
  it("Earn derives its LP percentage instead of hard-coding 48", () => {
    // It previously read "LPs earn a 48% share" in prose — the kind of literal
    // that keeps saying 48% after the protocol changes.
    expect(code(EARN)).toContain("LP_SHARE_PCT");
    expect(code(EARN)).toMatch(/legPercent\(/);
    expect(code(EARN)).not.toMatch(/\b48%\s*share/);
  });

  it("CONTROL: every surface sources its numbers from the shared module", () => {
    // Each must go through lib/fee-breakdown.ts (directly, or via the
    // FeeBreakdown component that does). A second copy of the shares is how
    // the rate and its label drifted apart in #2563.
    //
    // Asserting "no bare 4800/1600/2000 anywhere" was the first attempt and it
    // was wrong: it fired on an unrelated `setTimeout(..., 2000)` in the order
    // ticket. Forbidding integers tests spelling; this tests sourcing.
    for (const [name, src] of [
      ["create", CREATE],
      ["earn", EARN],
      ["stake", STAKE],
      ["ticket", TICKET],
    ] as const) {
      expect(code(src), `${name} must read from the shared module`).toMatch(
        /from "@\/(components\/FeeBreakdown|lib\/fee-breakdown)"/,
      );
    }
  });
});
