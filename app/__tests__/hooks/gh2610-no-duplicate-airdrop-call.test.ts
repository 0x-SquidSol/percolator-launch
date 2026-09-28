/**
 * #2608/#2610: useCreateMarket.ts used to fire POST /api/devnet-airdrop
 * automatically right after market creation, in BOTH the batched-launch path
 * and the per-step (sequential) path — duplicating the claim the "GET SIM-USDC
 * & TRADE" button on the success screen already makes on click
 * (LaunchSuccess.tsx's handleMintAndTrade). Every failure mode of that
 * duplicate call (500, 429, network error) put an unreportable error banner or
 * a permanently-stuck spinner on the success screen (see
 * gh2608-devnet-airdrop-send-confirm.test.ts and the LaunchSuccess tests in
 * CreateMarketWizard.test.tsx for the route/UI sides of this).
 *
 * Fix: remove both automatic fetch calls. `devnetMint` is still set
 * synchronously in both paths so the CTA button (which owns the one remaining
 * claim attempt) still renders.
 *
 * A full renderHook exercise of useCreateMarket's create() flow would need to
 * mock the entire wallet/connection/instruction-building surface for two
 * multi-step launch paths — this is a source scan instead, the same technique
 * __tests__/api/confirm-transaction-checked.test.ts already uses in this repo
 * for "no call site anywhere does X" properties.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../hooks/useCreateMarket.ts"),
  "utf8",
);

describe("#2610: useCreateMarket no longer duplicates the airdrop claim", () => {
  it("does not fetch /api/devnet-airdrop anywhere (that's the button's job now)", () => {
    expect(SOURCE).not.toMatch(/fetch\(\s*["']\/api\/devnet-airdrop["']/);
  });

  it("still sets devnetMint in both post-creation paths so the claim button renders", () => {
    const matches = SOURCE.match(/devnetMint:\s*(params\.mint\.toBase58\(\)|mintAddr)/g) ?? [];
    // One in the batched-launch path, one in the sequential path.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
