/**
 * Binds VaultGrid's new wiring to source (ordering itself is unit-tested in
 * lib/earn-vault-order.test.ts). The grid previously listed every live market
 * (vault-less included), sorted by TVL/Volume/Util only, and grew the page via
 * infinite scroll. This guards that it now:
 *   - builds the list through orderEarnVaults (hide vault-less + your-deposits-
 *     first + search + sort),
 *   - has a "Mine" toggle bound to mineOnly state,
 *   - caps the list in a max-height overflow-y-auto scroll box (no more
 *     IntersectionObserver / displayCount paging).
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../../components/earn/VaultGrid.tsx"),
  "utf8",
);

describe("VaultGrid — Mine filter + capped scroll", () => {
  it("orders/filters through orderEarnVaults with query/sortBy/mineOnly/depositOf", () => {
    expect(SRC).toMatch(/import \{ orderEarnVaults, type EarnSortKey \} from ['"]@\/lib\/earn-vault-order['"]/);
    expect(SRC).toMatch(/orderEarnVaults\(\s*markets\s*,\s*\{/);
    expect(SRC).toMatch(/mineOnly\s*,/);
    expect(SRC).toMatch(/depositOf:\s*\(slab\) => userDeposits\[slab\] \?\? 0/);
  });

  it("has a Mine toggle bound to mineOnly state", () => {
    expect(SRC).toMatch(/const \[mineOnly, setMineOnly\] = useState\(false\)/);
    expect(SRC).toMatch(/onClick=\{\(\) => setMineOnly\(\(v\) => !v\)\}/);
    expect(SRC).toMatch(/aria-pressed=\{mineOnly\}/);
  });

  it("caps the list in a scroll box instead of growing the page", () => {
    expect(SRC).toMatch(/max-h-\[\d+px\] overflow-y-auto/);
    // the infinite-scroll machinery is gone
    expect(SRC).not.toContain("IntersectionObserver");
    expect(SRC).not.toContain("displayCount");
  });
});
