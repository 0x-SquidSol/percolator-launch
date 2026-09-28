/**
 * Binds OrderTicket's Open/Close toggle + inline close flow to source. The
 * ticket previously only opened positions; closing meant scrolling to
 * PositionsDock. This adds an Open/Close toggle above Long/Short whose Close
 * mode shows a position summary and opens the shared ClosePositionModal.
 *
 * Source-binding: OrderTicket pulls a large hook/provider stack that a unit
 * render would have to reproduce; what matters here is the wiring — it reuses
 * useClosePosition + ClosePositionModal (no logic drift) and closes correctly.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../../components/trade/OrderTicket.tsx"),
  "utf8",
);

describe("OrderTicket — Open/Close toggle", () => {
  it("reuses useClosePosition + ClosePositionModal (no duplicated close logic)", () => {
    expect(SRC).toContain('import { useClosePosition } from "@/hooks/useClosePosition"');
    expect(SRC).toContain('import { ClosePositionModal } from "@/components/trade/ClosePositionModal"');
    expect(SRC).toMatch(/useClosePosition\(slabAddress\)/);
  });

  it("has an open/close mode toggle rendered above the order form", () => {
    expect(SRC).toMatch(/const \[ticketMode, setTicketMode\] = useState<"open" \| "close">\("open"\)/);
    expect(SRC).toMatch(/role="tablist"/);
    // toggle is emitted before the main form return
    const toggleAt = SRC.indexOf("openCloseToggle =");
    const closeReturnAt = SRC.indexOf('if (ticketMode === "close")');
    expect(toggleAt).toBeGreaterThan(-1);
    expect(closeReturnAt).toBeGreaterThan(toggleAt);
  });

  it("close mode opens the modal wired to this market's position", () => {
    expect(SRC).toMatch(/<ClosePositionModal[\s\S]*positionSize=\{existingPositionSize\}/);
    expect(SRC).toMatch(/onConfirm=\{handleConfirmClose\}/);
    // gated on an actual open position
    expect(SRC).toContain("showCloseModal && hasOpenPosition");
  });

  it("close success clears the entry cache on a full close and refreshes the ticket", () => {
    expect(SRC).toMatch(/await closePosition\(percent\)/);
    expect(SRC).toMatch(/percent === 100 && userAccount\) clearEntryPrice/);
    expect(SRC).toMatch(/setTimeout\(\(\) => refreshSlab\(\), \d+\)/);
  });

  it("shows an empty state when there is no position to close", () => {
    expect(SRC).toContain("No open position");
  });
});
