/**
 * #3320: My Markets' "connect the live price" rows.
 *  - name the market like its row below (the ticker this browser saved at launch), never the raw
 *    slab address once identity has loaded;
 *  - at the per-creator ceiling, stop offering a connection the ceiling refuses for good, and say
 *    so; a market ALREADY live-priced keeps its retry (registration skips the ceiling for it);
 *  - a click that the ceiling refuses (any candidate, either branch) ends in the same state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({
  cap: { status: "unknown", activeSlabs: new Set<string>(), max: null } as { status: string; activeSlabs: Set<string>; max: number | null },
  capArgs: [] as unknown[],
}));
const retry = vi.fn();
vi.mock("@/hooks/useCreateMarket", () => ({
  useCreateMarket: () => ({ state: { keeperMessage: null, keeperRegistering: false }, retryKeeperRegistration: retry }),
}));
vi.mock("@/components/create/RecoverSolBanner", () => ({ RecoverSolBanner: () => null }));
vi.mock("@/components/my-markets/attentionLogic", async (orig) => ({
  ...(await orig<object>()),
  isKeeperFeedDead: () => true,
  isEngineCrankStale: () => true,
}));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: new PublicKey("7Q3CVASeMNyYX4Q5zc7xCNhiCPZeSoMNLnYACUBR5qeQ"), connected: true }),
  useConnectionCompat: () => ({ connection: {} }),
}));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<object>()), getNetwork: () => "devnet" }));
vi.mock("@/hooks/useLivePriceCapacity", async (orig) => ({
  ...(await orig<object>()),
  useLivePriceCapacity: (...args: unknown[]) => {
    h.capArgs = args;
    return { ...h.cap, refresh: vi.fn() };
  },
}));

import { CreatorAttentionStrip } from "@/components/my-markets/CreatorAttentionStrip";
import { PER_CREATOR_CAP_COPY } from "@/lib/keeper-enrollment-guard";
import { KEEPER_REGISTER_COPY } from "@/lib/keeper-register-client";

const SLAB = new PublicKey("5v3v2VDVJcNL9dxjxAK7nXdeZh7fLkKANaijRDv6Lox1");
const slab = SLAB.toBase58();
const ADDR_LABEL = slab.slice(0, 8) + "…"; // useCreatedMarkets' label for it
const POOL = "9GBXHym9gxDZH3u6UnW71yXaixaBkG8K7EegywH2WQGg";
const market = { slabAddress: SLAB, label: ADDR_LABEL, configV17: {}, config: {} } as never;
const placeholder = { [slab]: { symbol: "UNKNOWN", name: null, dex_pool_address: null } } as never;
const registered = { [slab]: { symbol: "UNKNOWN", name: null, dex_pool_address: POOL, mainnet_ca: "CA1" } } as never;

const renderStrip = (details: never = placeholder) =>
  render(<CreatorAttentionStrip markets={[market]} details={details} identities={{}} currentSlot={null} />);
const saveRequest = () => {
  window.localStorage.setItem(`perc.keeperProofTx.${slab}`, "PROOFSIG");
  window.localStorage.setItem(
    `perc.keeperRequest.${slab}`,
    JSON.stringify({ slabAddress: slab, mainnetCA: "CA1", dexPoolAddress: POOL, dexType: "pumpswap", symbol: "TROLL" }),
  );
};
const connectBtn = () => screen.queryByRole("button", { name: /connect the live price/i });

beforeEach(() => {
  retry.mockReset();
  window.localStorage.clear();
  h.cap = { status: "unknown", activeSlabs: new Set(), max: null };
});

describe("naming", () => {
  it("uses the ticker this browser saved at launch, on the row and in the summary", () => {
    saveRequest();
    renderStrip();
    expect(screen.getAllByText("TROLL").length).toBeGreaterThan(0);
    expect(screen.getByText(/TROLL — each catches up/)).toBeTruthy();
    expect(screen.queryByText(ADDR_LABEL)).toBeNull();
  });

  it("with nothing saved here and only the placeholder known: 'Unnamed market', not the address", () => {
    renderStrip();
    expect(screen.getAllByText("Unnamed market").length).toBeGreaterThan(0);
    expect(screen.queryByText(ADDR_LABEL)).toBeNull();
  });

  it("the market's own ticker still wins over the saved one", () => {
    saveRequest();
    renderStrip({ [slab]: { symbol: "REAL", name: null, dex_pool_address: null } } as never);
    expect(screen.getAllByText("REAL").length).toBeGreaterThan(0);
  });
});

describe("the per-creator ceiling", () => {
  it("reads capacity only on devnet with a row to connect", () => {
    renderStrip();
    expect(h.capArgs).toEqual(["7Q3CVASeMNyYX4Q5zc7xCNhiCPZeSoMNLnYACUBR5qeQ", true]);
  });

  it("at the limit: no button, the reason and how to get more", () => {
    saveRequest();
    h.cap = { status: "atLimit", activeSlabs: new Set(["OTHER"]), max: 10 };
    renderStrip();
    expect(connectBtn()).toBeNull();
    expect(screen.getByTestId("live-price-wallet-limit").textContent).toBe(KEEPER_REGISTER_COPY.walletLimit(10));
    expect(KEEPER_REGISTER_COPY.walletLimit(10)).not.toMatch(/maintainer/i);
  });

  it("CRITICAL: a market already live-priced keeps its retry even when the wallet is at the limit", () => {
    h.cap = { status: "atLimit", activeSlabs: new Set([slab]), max: 10 };
    renderStrip(registered);
    expect(connectBtn()).toBeTruthy();
    expect(screen.queryByTestId("live-price-wallet-limit")).toBeNull();
  });

  it("unknown or below the limit: the button, as before", () => {
    saveRequest();
    renderStrip();
    expect(connectBtn()).toBeTruthy();
    h.cap = { status: "ok", activeSlabs: new Set(), max: 10 };
    renderStrip();
    expect(screen.getAllByRole("button", { name: /connect the live price/i }).length).toBe(2);
  });

  it("saved request: the ceiling refusing the memo-bound candidate ends the loop and the button", async () => {
    // Payload only: four dex-type candidates. The memo-bound one gets the ceiling's 403; the
    // others fail the memo first. Order puts the ceiling refusal in the middle.
    window.localStorage.setItem(`perc.keeperProofTx.${slab}`, "PROOFSIG");
    window.localStorage.setItem(
      `perc.keeperPayload.${slab}`,
      JSON.stringify({ dex_pool_address: POOL, symbol: "TROLL", mainnet_ca: "CA1" }),
    );
    retry
      .mockResolvedValueOnce({ registered: false, message: "Registration proof refused: memo mismatch" })
      .mockResolvedValueOnce({ registered: false, message: PER_CREATOR_CAP_COPY })
      .mockResolvedValue({ registered: false, message: "Registration proof refused: memo mismatch" });
    renderStrip();
    fireEvent.click(connectBtn()!);
    await waitFor(() => expect(screen.getByTestId("live-price-wallet-limit")).toBeTruthy());
    expect(retry).toHaveBeenCalledTimes(2);
    expect(connectBtn()).toBeNull();
  });

  it("pool branch: a ceiling refusal on click ends the button too (its result used to be ignored)", async () => {
    retry.mockResolvedValue({ registered: false, message: PER_CREATOR_CAP_COPY });
    renderStrip(registered);
    fireEvent.click(connectBtn()!);
    await waitFor(() => expect(screen.getByTestId("live-price-wallet-limit")).toBeTruthy());
    // max unknown from a refusal alone: no number is made up
    expect(screen.getByTestId("live-price-wallet-limit").textContent).toBe(KEEPER_REGISTER_COPY.walletLimit(null));
  });

  it("any other refusal keeps the button and shows its own reason", async () => {
    saveRequest();
    retry.mockResolvedValue({ registered: false, message: "Live price couldn't connect just now. Your market is live; try again in a moment." });
    renderStrip();
    fireEvent.click(connectBtn()!);
    await waitFor(() => expect(retry).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/try again in a moment/)).toBeTruthy());
    expect(connectBtn()).toBeTruthy();
    expect(screen.queryByTestId("live-price-wallet-limit")).toBeNull();
  });
});
