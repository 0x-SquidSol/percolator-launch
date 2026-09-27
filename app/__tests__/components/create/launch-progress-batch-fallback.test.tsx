/**
 * The market launch has a fast path that signs all seven transactions in ONE
 * wallet approval. When it fails before broadcasting anything, it silently
 * falls back to signing six times.
 *
 * The fallback itself is correct — nothing is on chain, so the sequential path
 * is safe. What was wrong is that it threw the REASON away:
 *
 *     } catch (err) {
 *       if (!broadcastStarted) {
 *         return { status: "fallback" };   // err never used
 *       }
 *
 * The batch has several unrelated ways to throw before broadcast — a 429 from
 * the devnet pre-fund's 24h faucet gate, a keeper co-sign failure, an airdrop
 * that did not confirm — and from the outside they are indistinguishable. The
 * only symptom was a user signing six times, on any wallet (reproduced on both
 * Phantom and Solflare), with nothing anywhere saying why.
 *
 * See #2586.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LaunchProgress } from "@/components/create/LaunchProgress";

type ProgressState = Parameters<typeof LaunchProgress>[0]["state"];

/** Mid-launch on the sequential path: loading, no error, not the batch phase. */
function signingState(over: Partial<ProgressState> = {}): ProgressState {
  return {
    step: 1,
    loading: true,
    error: null,
    slabAddress: null,
    txSigs: [],
    stepLabel: "Oracle setup & pre-LP crank...",
    ...over,
  } as ProgressState;
}

describe("a degraded six-prompt launch says so", () => {
  it("shows the reason the one-approval path was unavailable", () => {
    render(
      <LaunchProgress
        state={signingState({
          batchFallbackReason: "Devnet pre-fund failed: Already pre-funded recently",
        })}
      />,
    );

    expect(screen.getByText(/Step 2 of 6/)).toBeInTheDocument();
    expect(
      screen.getByText(/Already pre-funded recently/),
    ).toBeInTheDocument();
  });

  it("CONTROL: says nothing when the batch was never attempted", () => {
    // Resume and retry flows deliberately skip the batch, and a successful
    // batch never reaches this view. Neither is degraded, so neither should
    // carry an explanation — otherwise the line appears always and is ignored.
    render(<LaunchProgress state={signingState()} />);

    expect(screen.getByText(/Step 2 of 6/)).toBeInTheDocument();
    expect(screen.queryByText(/One-approval launch unavailable/)).toBeNull();
  });

  it("does not present it as an error", () => {
    // Nothing failed from the user's side — the launch is still running, just
    // with more prompts. Rendering it in the error style would tell someone
    // their market broke when it did not.
    const { container } = render(
      <LaunchProgress
        state={signingState({ batchFallbackReason: "Keeper co-sign failed (503)" })}
      />,
    );

    const shortToned = container.querySelectorAll('[class*="--short"]');
    expect(shortToned.length).toBe(0);
  });

  it("stays quiet once the launch is no longer mid-signature", () => {
    // The line belongs to the signing phase. Left rendered after `loading`
    // clears, it would sit under a finished market explaining a path the user
    // has already walked.
    render(
      <LaunchProgress
        state={signingState({ loading: false, batchFallbackReason: "Airdrop transaction failed on-chain" })}
      />,
    );

    expect(screen.queryByText(/Airdrop transaction failed/)).toBeNull();
  });
});
