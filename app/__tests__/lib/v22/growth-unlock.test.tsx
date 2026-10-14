import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { cleanup, render, screen } from "@testing-library/react";
import { GrowthTicketPanel } from "@/components/trade/GrowthTicketPanel";
import { growthMarketView, growthTicketDecision } from "@/lib/v21/growth-market";
import { assetGrowthAccountOffsetV19 } from "@/lib/v21/sdk";
import { V22_COPY } from "@/lib/v22/copy";
import {
  NO_UNLOCK,
  bandRGapBps,
  capitalDoublings,
  clampEnforced,
  compactUsd,
  depthTier,
  effectiveDepthE6,
  growthRecordBytes,
  growthTargetCeilingX100,
  growthUnlockView,
  readGrowthDepth,
  unlockLine,
  waitLabel,
} from "@/lib/v22/growth-unlock";
import { ENGINE, marketRaw } from "../v21/fixtures";

// The fixtures are v2.1-layout markets: pin the v2.1 geometry whatever the suite-wide flag is.
beforeEach(() => __setDevnetV22ForTest(false));
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

const NOW = 1_000_000n;
const BAND = 130; // d = 1.3%
const GAP = 397; // G(1.3%) = ceil(1.013^2 / 0.987) - 1 = 3.97% in bps
const USD = 1_000_000n; // 1 USD in e6 / atoms
const LAUNCH_CAP = 100n * USD;

interface Scenario {
  band?: number;
  gap?: number;
  launch?: number;
  tier?: number;
  ceil?: number;
  ceilSlot?: bigint;
  lpCapital?: bigint;
  hlock?: number;
  depth?: { source?: number; usd?: number; prevUsd?: number; ageSlots?: bigint } | null;
  now?: bigint | null;
}

function scenario(s: Scenario = {}) {
  const gap = s.gap ?? GAP;
  const launch = s.launch ?? 300;
  const raw = marketRaw({ cLaunch: LAUNCH_CAP, launch, tier: s.tier ?? 1_000, ceil: s.ceil ?? launch, gap }, s.hlock ?? 0);
  const off = assetGrowthAccountOffsetV19(0);
  const v = new DataView(raw.buffer);
  v.setBigUint64(off + 8, s.ceilSlot ?? NOW - 20_000n, true); // ceil_slot
  const d = s.depth === undefined ? null : s.depth;
  if (d) {
    raw[off + 44] = d.source ?? 1;
    v.setBigUint64(off + 56, BigInt(d.usd ?? 0) * USD, true);
    v.setBigUint64(off + 64, NOW - (d.ageSlots ?? 10n), true);
    v.setBigUint64(off + 72, BigInt(d.prevUsd ?? d.usd ?? 0) * USD, true);
  }
  const view = growthMarketView({
    raw,
    engine: ENGINE,
    lp: { capital: s.lpCapital ?? LAUNCH_CAP, pnl: 0n, feeCredits: 0n },
    lpEffectiveQ: -10_000_000n,
    bound: true,
  })!;
  const record = raw.subarray(off, off + 120);
  return { view, record, input: { view, bandBps: s.band ?? BAND, record, nowSlot: s.now === undefined ? NOW : s.now } };
}
const run = (s: Scenario = {}) => growthUnlockView(scenario(s).input);
const line = (s: Scenario = {}) => unlockLine(run(s).unlock);

describe("band clamp predicate (graduation on / off)", () => {
  it("derives r_gap from the band and fails closed on a mismatch", () => {
    expect(bandRGapBps(130)).toBe(BigInt(GAP));
    expect(bandRGapBps(0)).toBeNull();
    expect(bandRGapBps(2_001)).toBeNull();
    expect(clampEnforced(BAND, GAP)).toBe(true);
    expect(clampEnforced(BAND, GAP + 1)).toBe(false);
    expect(clampEnforced(0, GAP)).toBe(false);
  });
  it("off-band market: no tier, no unlock line, nothing said", () => {
    expect(run({ band: 0, depth: { usd: 30_000 } })).toEqual(NO_UNLOCK);
    expect(line({ band: 0 })).toBeNull();
  });
  it("a band market whose stored r_gap is not the derived one is treated as off", () => {
    expect(run({ gap: 500 })).toEqual(NO_UNLOCK);
  });
  it("clock unknown: graduation on but no tier or unlock is claimed", () => {
    expect(run({ now: null })).toEqual({ graduation: true, tier: null, unlock: null });
  });
});

describe("depth tiers 0-3", () => {
  const eff = (usd: number) => BigInt(usd) * USD;
  it("thresholds are $25k / $100k / $500k", () => {
    expect([0, 24_999, 25_000, 99_999, 100_000, 499_999, 500_000].map((u) => depthTier(eff(u), 2))).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });
  it("keeper-attested depth is capped at tier 1 (tiers 2 and 3 need an on-chain pool source)", () => {
    expect(depthTier(eff(900_000), 1)).toBe(1);
    expect(depthTier(eff(900_000), 2)).toBe(3);
  });
  it("shows the tier on a band market from fresh depth", () => {
    expect(run({}).tier).toBe(0);
    expect(run({ depth: { usd: 30_000 } }).tier).toBe(1);
    expect(run({ depth: { usd: 900_000 } }).tier).toBe(1);
    expect(run({ depth: { source: 2, usd: 150_000 } }).tier).toBe(2);
    expect(run({ depth: { source: 2, usd: 600_000 } }).tier).toBe(3);
  });
  it("stale depth is tier 0, and so is a one-push spike (min with the previous reading)", () => {
    expect(run({ depth: { usd: 30_000, ageSlots: 151n } }).tier).toBe(0);
    expect(run({ depth: { usd: 30_000, ageSlots: 150n } }).tier).toBe(1);
    expect(run({ depth: { usd: 30_000, prevUsd: 10_000 } }).tier).toBe(0);
  });
  it("reads the depth fields; absent / foreign bytes give nothing", () => {
    const { record } = scenario({ depth: { usd: 30_000 } });
    const d = readGrowthDepth(record)!;
    expect(d).toMatchObject({ source: 1, depthE6: 30_000n * USD, prevE6: 30_000n * USD });
    expect(readGrowthDepth(null)).toBeNull();
    expect(readGrowthDepth(new Uint8Array(10))).toBeNull();
    expect(effectiveDepthE6(5n, 7n, NOW, NOW)).toBe(5n);
    expect(effectiveDepthE6(5n, 7n, NOW - 151n, NOW)).toBe(0n);
    expect(depthTier(eff(900_000), 0)).toBe(0); // source none is tier 0 whatever the number says
    expect(growthRecordBytes(null)).toBeNull();
    expect(growthRecordBytes(new Uint8Array(40))).toBeNull();
  });
});

describe("ceiling target (graduation on / off)", () => {
  const base = { tier: 1, lLaunchX100: 300, lTierX100: 1_000, cM: 100n, cLaunchAtoms: 100n, bandBps: BAND, rGapBps: GAP };
  const at = (steps: number, over: Partial<typeof base & { forceDown: boolean; bandBps: number }> = {}) =>
    growthTargetCeilingX100({ ...base, cM: 100n * 2n ** BigInt(steps), ...over });
  it("graduation on: capital doublings raise it, depth caps it, tier max caps it", () => {
    expect(at(0)).toBe(300);
    expect(at(1)).toBe(400);
    expect(at(5)).toBe(500); // depth tier 1 = 5x
    expect(at(5, { tier: 3 })).toBe(800); // 3 + 5 steps
    expect(at(40, { tier: 3 })).toBe(1_000);
    expect(at(5, { tier: 0 })).toBe(300);
  });
  it("graduation off or forced down: the launch ceiling", () => {
    expect(at(5, { bandBps: 0 })).toBe(300);
    expect(at(5, { forceDown: true })).toBe(300);
    expect(at(5, { bandBps: 0, lLaunchX100: 1_200 })).toBe(1_000);
  });
  it("counts capital doublings", () => {
    expect([0n, 99n, 100n, 199n, 200n, 800n, 1_599n].map((c) => capitalDoublings(c, 100n))).toEqual([0, 0, 0, 0, 1, 3, 3]);
    expect(capitalDoublings(10n, 0n)).toBe(0);
  });
});

describe("the one next-unlock line", () => {
  it("tier 0 with the market's backing still at its launch level: one line says both needs", () => {
    expect(line()).toBe("4x unlocks at $25k pool depth and $100 more market backing");
    expect(line({ depth: { usd: 5_000 } })).toBe("4x unlocks at $25k pool depth and $100 more market backing");
  });
  it("tier 0 with the backing already doubled: depth alone is the missing piece", () => {
    expect(line({ lpCapital: 250n * USD })).toBe("4x unlocks when pool depth reaches $25k");
  });
  it("stale depth reads like no depth (same calm line, tier 0)", () => {
    expect(line({ depth: { usd: 30_000, ageSlots: 400n }, lpCapital: 250n * USD })).toBe("4x unlocks when pool depth reaches $25k");
  });
  it("a launch leverage already at the tier-1 depth step has nothing further to unlock", () => {
    expect(line({ launch: 500, ceil: 500, depth: { usd: 30_000 } })).toBeNull();
  });
  it("tier 1 with the ceiling at its capital step: names the capital for the next step", () => {
    expect(line({ depth: { usd: 30_000 } })).toBe("4x unlocks when pool capital reaches $200");
  });
  it("earned but not yet applied: the ratchet step with a time", () => {
    const grown = { depth: { usd: 30_000 }, lpCapital: 250n * USD, ceil: 300 };
    expect(line({ ...grown, ceilSlot: NOW - 100n })).toBe("Next step: 4x after about an hour");
    expect(line({ ...grown, ceilSlot: NOW - 8_000n })).toBe("Next step: 4x after about 7 minutes");
    expect(line({ ...grown, ceilSlot: NOW - 9_000n })).toBe("Next step: 4x at the next update");
  });
  it("keeper-attested depth never promises tier 2 or 3", () => {
    const rich = { depth: { usd: 900_000 }, lpCapital: 800n * USD, ceil: 500 };
    expect(line(rich)).toBeNull();
  });
  it("an on-chain depth source at tier 1 can name tier 2", () => {
    const rich = { depth: { source: 2, usd: 30_000 }, lpCapital: 3_200n * USD, ceil: 500 };
    expect(line(rich)).toBe("8x unlocks when pool depth reaches $100k");
  });
  it("nothing when the ceiling is at the market's own maximum, or while the market recovers from a loss", () => {
    expect(line({ tier: 300, depth: { usd: 30_000 } })).toBeNull();
    expect(line({ hlock: 1 })).toBeNull();
  });
  it("never shows a raw bps / x100 number", () => {
    for (const s of [{}, { depth: { usd: 30_000 } }, { depth: { usd: 30_000 }, lpCapital: 250n * USD }]) {
      expect(line(s) ?? "").not.toMatch(/bps|x100|\d{4,}/);
    }
  });
  it("label helpers", () => {
    expect([999, 25_000, 25_500, 100_000, 1_500_000, 2_000_000].map(compactUsd)).toEqual(["$999", "$25k", "$25.5k", "$100k", "$1.5M", "$2M"]);
    expect([1n, 150n, 1_000n, 4_000n, 9_000n].map(waitLabel)).toEqual(["about a minute", "about a minute", "about 7 minutes", "about 27 minutes", "about an hour"]);
    expect(unlockLine(null)).toBeNull();
  });
});

describe("GrowthTicketPanel: max line, tier badge, unlock line", () => {
  const draw = (s: Scenario, withUnlock = true) => {
    const { view, input } = scenario(s);
    render(
      <GrowthTicketPanel
        view={view}
        decision={growthTicketDecision(view, "long", 0n, 1_000_000n)}
        direction="long"
        unlock={withUnlock ? growthUnlockView(input) : null}
      />,
    );
  };
  it("graduation on: 'Max leverage now' per side, tier badge, one unlock line", () => {
    draw({});
    expect(screen.getByTestId("growth-max-now")).toHaveTextContent(/^Max leverage now: .*x long · .*x short$/);
    expect(screen.getByTestId("growth-tier")).toHaveTextContent("Liquidity tier 0");
    expect(screen.getByTestId("growth-unlock")).toHaveTextContent("4x unlocks at $25k pool depth and $100 more market backing");
    expect(screen.getByTestId("growth-adjusts")).toHaveTextContent("Leverage adjusts with market backing.");
  });
  it("tier badge follows the depth", () => {
    draw({ depth: { usd: 30_000 } });
    expect(screen.getByTestId("growth-tier")).toHaveTextContent("Liquidity tier 1");
  });
  it("off-band market: no badge and no unlock line, the max line is unchanged", () => {
    draw({ band: 0 });
    expect(screen.queryByTestId("growth-tier")).toBeNull();
    expect(screen.queryByTestId("growth-unlock")).toBeNull();
    expect(screen.getByTestId("growth-max-now")).toBeInTheDocument();
  });
  it("no unlock prop (flag off / not a growth ticket): same as before", () => {
    draw({}, false);
    expect(screen.queryByTestId("growth-tier")).toBeNull();
    expect(screen.queryByTestId("growth-unlock")).toBeNull();
  });
  it("copy never claims 'up to 10x' on its own or shows raw numbers", () => {
    draw({ depth: { usd: 30_000 } });
    expect(screen.getByTestId("growth-ticket-panel").textContent).not.toMatch(/up to \d+x|bps|x100/i);
    expect(V22_COPY.growth.tierTip.split(".").filter(Boolean)).toHaveLength(1);
  });
});
