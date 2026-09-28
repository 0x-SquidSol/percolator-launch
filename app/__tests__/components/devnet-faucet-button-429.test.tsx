/**
 * The trade page's faucet button calls the same /api/devnet-airdrop as the launch
 * screen's claim, and had the same 429 conflation: `if (resp.status === 429)` fed
 * `data.nextClaimAt` straight into a countdown.
 *
 * Only the daily claim gate sends nextClaimAt. The route's per-IP fund limiter
 * and middleware.ts's global /api/* limiter both 429 without it and mint nothing,
 * so the countdown computed `new Date(undefined).getTime()` — NaN — and rendered
 * "NaNh NaNm" where the reason should be.
 *
 * Sibling of the launch-screen fix; see launch-success-claim-state.test.tsx.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/config", () => ({ getNetwork: () => "devnet" }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({
    publicKey: { toBase58: () => "WaLLet1111111111111111111111111111111111111" },
    connected: true,
  }),
}));

import { DevnetTokenFaucetButton } from "@/components/trade/DevnetTokenFaucetButton";

const MINT = "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs";

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

const click = async () => {
  render(<DevnetTokenFaucetButton mintAddress={MINT} symbol="Sim-USDC" />);
  fireEvent.click(screen.getByRole("button"));
};

describe("the trade-page faucet button distinguishes the two 429s", () => {
  it("a 429 without nextClaimAt shows the reason, not a NaN countdown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many requests. Please slow down and try again shortly." }),
    }));

    await click();

    await waitFor(() => expect(screen.getByText(/Too many requests/i)).toBeInTheDocument());
    // The specific broken render this fixes.
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.queryByText(/Next Sim-USDC claim in/i)).toBeNull();
  });

  it("CONTROL: a 429 WITH nextClaimAt still shows the countdown", async () => {
    // The daily gate's exit — this behaviour must not change.
    const inThreeHours = new Date(Date.now() + 3 * 3_600_000 + 60_000).toISOString();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: "Already claimed", nextClaimAt: inThreeHours }),
    }));

    await click();

    await waitFor(() => expect(screen.getByText(/Next Sim-USDC claim in/i)).toBeInTheDocument());
    expect(screen.getByText(/^3h/)).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
});
