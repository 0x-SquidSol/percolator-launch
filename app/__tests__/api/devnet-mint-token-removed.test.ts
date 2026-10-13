/**
 * #3469: POST /api/devnet-mint-token converted $500 into a token amount with DexScreener's
 * priceUsd and minted it from the shared devnet mint authority with no ceiling — a
 * dust-priced token turned one request into tens of billions of tokens. Nothing in the app
 * had called it since the wizard moved to Sim-USDC collateral (b358fb90), so it was removed
 * rather than hardened. /api/devnet-airdrop is the live $500 path and clamps to MAX_RAW.
 *
 * Next.js serves a route from any route.{ts,tsx,js,jsx} in the directory, so the whole
 * directory must stay absent.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const API_DIR = path.resolve(__dirname, "../../app/api");

describe("#3469: /api/devnet-mint-token stays removed", () => {
  it("has no route directory", () => {
    expect(fs.existsSync(path.join(API_DIR, "devnet-mint-token"))).toBe(false);
  });

  it("its only helper, the orphaned rate limiter, is gone too", () => {
    expect(fs.existsSync(path.resolve(__dirname, "../../lib/devnet-mirror-mint-rate-limit.ts"))).toBe(false);
  });
});
