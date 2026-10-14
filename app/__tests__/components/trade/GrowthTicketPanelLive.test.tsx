import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const slot = vi.hoisted(() => ({ value: 1_000_000n as bigint | null }));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => slot.value }));

import { GrowthTicketPanelLive } from "@/components/trade/GrowthTicketPanelLive";
import { growthMarketView, growthTicketDecision } from "@/lib/v21/growth-market";
import { ENGINE, LP, marketRaw } from "../../lib/v21/fixtures";

afterEach(cleanup);
const raw = marketRaw({ launch: 300, ceil: 300, gap: 397 });
const view = growthMarketView({ raw, engine: ENGINE, lp: LP, lpEffectiveQ: -1_000_000n, bound: true })!;
const decision = growthTicketDecision(view, "long", 0n, 1_000_000n);

describe("GrowthTicketPanelLive", () => {
  it("band market: the badge appears once the slot is known", () => {
    // growthRecordBytes needs a v2.2 market geometry; with a v2.1 fixture it returns null -> tier 0 from absent depth.
    render(<GrowthTicketPanelLive view={view} decision={decision} direction="long" raw={raw} bandBps={130} />);
    expect(screen.getByTestId("growth-tier")).toHaveTextContent("Liquidity tier 0");
  });
  it("no band view or an off-band market: no badge, no unlock line", () => {
    const { rerender } = render(<GrowthTicketPanelLive view={view} decision={decision} direction="long" raw={raw} bandBps={null} />);
    expect(screen.queryByTestId("growth-tier")).toBeNull();
    rerender(<GrowthTicketPanelLive view={view} decision={decision} direction="long" raw={raw} bandBps={0} />);
    expect(screen.queryByTestId("growth-tier")).toBeNull();
    expect(screen.queryByTestId("growth-unlock")).toBeNull();
  });
  it("clock unknown: no badge", () => {
    slot.value = null;
    render(<GrowthTicketPanelLive view={view} decision={decision} direction="long" raw={raw} bandBps={130} />);
    expect(screen.queryByTestId("growth-tier")).toBeNull();
    slot.value = 1_000_000n;
  });
});
