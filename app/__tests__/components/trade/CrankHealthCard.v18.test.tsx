/**
 * CrankHealthCard on REAL v18 devnet bytes (TRUMP CdN8r7FB, keeper cranking
 * every few seconds at capture). The card used to read `slot_last` through a
 * hardcoded 512-byte wrapper offset (v17); v18's wrapper is 1024 bytes, so it
 * read 0 and reported every live market as ~505M slots behind → "STALE".
 */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const f = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/CdN8r7FB.freshness.market.json"), "utf8"),
) as { contextSlot: number; dataBase64: string };
const raw = new Uint8Array(Buffer.from(f.dataBase64, "base64"));

vi.mock("@/hooks/useEngineState", () => ({
  useEngineState: () => ({ engine: null, loading: false, isV17: true }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({ raw }),
}));
vi.mock("@/hooks/useEngineFreshness", () => ({
  useEngineFreshness: () => ({ currentSlot: BigInt(f.contextSlot) }),
}));
vi.mock("@/components/ui/Tooltip", () => ({ InfoIcon: () => null }));

import { CrankHealthCard } from "@/components/trade/CrankHealthCard";

describe("CrankHealthCard — v18 slot_last", () => {
  it("a live-cranked v18 market reads FRESH, not STALE", () => {
    render(<CrankHealthCard />);
    expect(screen.getByText("FRESH")).toBeInTheDocument();
    expect(screen.queryByText("STALE")).not.toBeInTheDocument();
  });
});
