/**
 * Binds LpPositionDashboard's "Est. Earned" wiring to source (the estimate math
 * itself is unit-tested in lib/lp-earned.test.ts). The card previously showed
 * Position Value / LP Tokens / Pool Share / Share Value / Redemption Rate / Total
 * Vault but no sense of how much the position had EARNED. This guards that it now:
 *   - derives the estimate from lib/lp-earned (not an ad-hoc local formula),
 *   - feeds it the SAME basis as Position Value (userRedeemableValue + the share
 *     price it already renders), so the two figures can't disagree,
 *   - labels it honestly as an estimate and states earnings are auto-paid (no
 *     claim), so the on-chain reality isn't misrepresented as settled P&L.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../../components/earn/LpPositionDashboard.tsx"),
  "utf8",
);

describe("LpPositionDashboard — Est. Earned", () => {
  it("computes the estimate through lib/lp-earned, not a local formula", () => {
    expect(SRC).toMatch(/import \{ estimateLpEarnedSincePar \} from ['"]@\/lib\/lp-earned['"]/);
    expect(SRC).toMatch(/estimateLpEarnedSincePar\(\s*userRedeemableValue\s*,\s*redemptionRateE6\s*\)/);
  });

  it("renders an Est. Earned figure", () => {
    expect(SRC).toMatch(/Est\. Earned/);
    expect(SRC).toMatch(/earnedFloat\.toFixed\(4\)/);
  });

  it("labels it as an estimate and states there is nothing to claim", () => {
    expect(SRC).toMatch(/estimate/i);
    expect(SRC).toMatch(/nothing to claim/i);
    expect(SRC).toMatch(/since par/i);
  });
});
