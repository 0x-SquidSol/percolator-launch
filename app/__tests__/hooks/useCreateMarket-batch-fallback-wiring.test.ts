/**
 * Pins the HOOK half of #2586: the catch produces a reason, the caller stores
 * it, and every attempt clears it first.
 *
 * WHY THIS FILE EXISTS. The first version of this fix shipped with tests only
 * against LaunchProgress. Review found the decisive hole: reverting
 * useCreateMarket.ts wholesale — union back to `{ status: "fallback" }`, no
 * warn, no `setState` — left the whole suite green. The field would then never
 * be populated in production and the feature would be entirely dead behind a
 * passing build, which is the same class of defect the fix is about.
 *
 * Source text, not behaviour, because the producer sits mid-way through
 * `attemptFreshBatchedLaunch` behind a live connection, a wallet and two
 * fetches. A source scan is the weaker instrument and is used deliberately:
 * these assertions pin WIRING (does the reason flow hook → state), while
 * describe-batch-fallback.test.ts pins the BEHAVIOUR of the reason itself.
 *
 * Note tsconfig.json excludes __tests__, so nothing here is type-checked; that
 * is another reason the wiring needs an explicit assertion rather than trusting
 * the compiler to catch a dropped field.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const hookSource = readFileSync(resolve(process.cwd(), "hooks/useCreateMarket.ts"), "utf8");

// The producer lives inside attemptFreshBatchedLaunch; the consumer is in the
// create() callback, which is AFTER `const STEP_LABELS` and so outside it.
const batchStart = hookSource.indexOf("async function attemptFreshBatchedLaunch");
const batchEnd = hookSource.indexOf("\nconst STEP_LABELS", batchStart);
const batchSource = hookSource.slice(batchStart, batchEnd);
const afterBatch = hookSource.slice(batchEnd);

// The per-attempt reset specifically — NOT reset() and not the initial state,
// both of which also set this field to null. Matching the bare text anywhere in
// the file let the mutant that deletes THIS clear pass on one of those other
// two occurrences.
const attemptResetStart = afterBatch.indexOf("step: startStep,");
const attemptReset = afterBatch.slice(
  afterBatch.lastIndexOf("setState(", attemptResetStart),
  afterBatch.indexOf("}));", attemptResetStart),
);

describe("the source scan is actually scanning something", () => {
  it("has locatable bounds", () => {
    // A moved marker turns every assertion below into a vacuous pass while
    // still looking like an ordinary green test. This has already happened once
    // in the sibling file (useCreateMarket-fresh-batched-registration.test.ts),
    // where a reordered promise made indexOf return -1.
    expect(batchStart).toBeGreaterThan(-1);
    expect(batchEnd).toBeGreaterThan(batchStart);
    expect(batchSource.length).toBeGreaterThan(5_000);
    expect(afterBatch).toContain("const STEP_LABELS");
  });
});

describe("the reason cannot be dropped from the hook", () => {
  it("the fallback variant of the outcome union carries a reason", () => {
    // Typed as `{ status: "fallback"; reason: string }` so a bare
    // `return { status: "fallback" }` is a compile error at the producer.
    expect(hookSource).toMatch(/status:\s*"fallback";\s*reason:\s*string/);
  });

  it("the catch returns the reason, not a bare fallback", () => {
    expect(batchSource).toMatch(/status:\s*"fallback",\s*reason/);
    // The pre-fix shape. If this reappears anywhere in the function the reason
    // is being thrown away again on at least one path.
    expect(batchSource).not.toMatch(/return\s*\{\s*status:\s*"fallback"\s*\}/);
  });

  it("derives the reason from the caught error rather than a constant", () => {
    // A hardcoded string would satisfy the type and log a line, while telling
    // the user nothing about which of the five pre-broadcast failures happened.
    expect(batchSource).toMatch(/describeBatchFallback\(\s*err\s*\)/);
  });

  it("the caller stores it in state", () => {
    // Deleting this line is the mutant that made the feature dead code.
    expect(afterBatch).toMatch(/batchFallbackReason:\s*outcome\.reason/);
  });

  it("every attempt clears it before running", () => {
    // Without this a reason from an earlier fallback survives into a "Retry
    // Step N" that skips the batch entirely, and is rendered under a run that
    // never attempted it. Asserted against the per-attempt reset, because
    // reset() and the initial state clear it too and would otherwise satisfy
    // this while the retry path stayed broken.
    expect(attemptReset).toContain("step: startStep");
    expect(attemptReset).toMatch(/batchFallbackReason:\s*null/);
    // It is a spread update, which is why an unset field would PERSIST rather
    // than default. Pins the premise the clear exists for.
    expect(attemptReset).toContain("...s,");
  });

  it("the state field is required, so reset() and the initial state must name it", () => {
    // Optional meant the compiler guarded only the producer: both the store and
    // the clear could be deleted in silence.
    expect(hookSource).toMatch(/^\s*batchFallbackReason: string \| null;/m);
    expect(hookSource).not.toMatch(/batchFallbackReason\?:/);
  });
});
