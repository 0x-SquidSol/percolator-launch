/**
 * The reason a batched market launch fell back to six wallet prompts, phrased
 * for the person who is about to sign those six prompts.
 *
 * Raw `err.message` got three things wrong, all found in review of #2586:
 * a declined approval was reported as an unavailable fast path, an empty
 * message rendered as nothing at all, and server text written for operators
 * was shown to market creators.
 */

import { describe, expect, it } from "vitest";
import { describeBatchFallback } from "@/hooks/useCreateMarket";

describe("a declined approval is not an unavailable fast path", () => {
  it("says the user declined, not that the batch was unavailable", () => {
    // Rejecting the single batch prompt throws BEFORE broadcast, so it lands
    // in the fallback. Reporting "one-approval launch unavailable" states the
    // opposite of what happened: it was available and the user declined it.
    for (const msg of [
      "User rejected the request.",
      "WalletSignTransactionError: User rejected the request.",
      "Transaction cancelled by user",
    ]) {
      expect(describeBatchFallback(new Error(msg))).toBe(
        "you declined the single-approval signature",
      );
    }
  });

  it("CONTROL: a genuine failure is still reported as itself", () => {
    // Guards against classifying everything as a rejection, which would hide
    // the real causes this change exists to expose.
    expect(describeBatchFallback(new Error("Keeper co-sign failed (503)"))).toContain(
      "Keeper co-sign failed (503)",
    );
  });
});

describe("the reason is never empty", () => {
  it("falls back to the error name when the message is blank", () => {
    // `new Error()` has message "". An empty string satisfies `reason: string`
    // and then renders as nothing — the exact silence being fixed.
    const blank = new Error();
    blank.name = "AbortError";
    expect(describeBatchFallback(blank)).toBe("AbortError");
  });

  it("falls back to a sentence when there is nothing at all", () => {
    const nameless = new Error();
    nameless.name = "";
    expect(describeBatchFallback(nameless).length).toBeGreaterThan(0);
  });
});

describe("operator text does not reach the user", () => {
  it("strips the server env-var question", () => {
    // Addressed to whoever runs the deployment, not to someone launching a
    // market. The full text still goes to the console.
    const out = describeBatchFallback(
      new Error("Keeper co-sign failed (500): not configured. Is PLAYGROUND_KEEPER_KEYPAIR set in server env?"),
    );
    expect(out).not.toContain("PLAYGROUND_KEEPER_KEYPAIR");
    expect(out).not.toContain("server env");
    // CONTROL: the actionable part survives the strip.
    expect(out).toContain("Keeper co-sign failed (500)");
  });
});

describe("it cannot throw", () => {
  it("survives values that break String()", () => {
    // This runs OUTSIDE any try — a throw here escapes create() as an
    // unhandled rejection and strands the wizard on "Step 1 of 6" with no
    // error block, so no Retry and no Start Over.
    const hostile = Object.create(null);
    expect(() => describeBatchFallback(hostile)).not.toThrow();

    const throwingGetter = new Error("x");
    Object.defineProperty(throwingGetter, "message", {
      get() { throw new Error("boom"); },
    });
    expect(() => describeBatchFallback(throwingGetter)).not.toThrow();
    expect(describeBatchFallback(throwingGetter).length).toBeGreaterThan(0);
  });
});
