import { describe, expect, it } from "vitest";
import { closeLimitFromEngine, CLOSE_PRICE_UNREADABLE } from "@/lib/close-limit";
import { UserFacingError } from "@/lib/errorMessages";

describe("closeLimitFromEngine: a close's limit comes from the engine's effective_price", () => {
  it("buy (closing a short): effective x 1.05, rounded up", () => {
    expect(closeLimitFromEngine({ effectivePriceE6: 1_000_000n }, 5n)).toBe(1_050_000n);
    expect(closeLimitFromEngine({ effectivePriceE6: 57n }, 5n)).toBe(60n);
  });
  it("sell (closing a long): effective x 0.95, rounded down, never 0 on a sub-cent market", () => {
    expect(closeLimitFromEngine({ effectivePriceE6: 1_000_000n }, -5n)).toBe(950_000n);
    expect(closeLimitFromEngine({ effectivePriceE6: 57n }, -5n)).toBe(54n);
  });
  it("no engine view, zero or insane price: refuses with the calm one-liner (UserFacingError)", () => {
    for (const engine of [null, { effectivePriceE6: 0n }, { effectivePriceE6: 10n ** 18n }]) {
      let err: unknown = null;
      try {
        closeLimitFromEngine(engine, 5n);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UserFacingError);
      expect((err as Error).message).toBe(CLOSE_PRICE_UNREADABLE);
    }
  });
});
