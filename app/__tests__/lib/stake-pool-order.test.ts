import { describe, it, expect } from "vitest";
import { orderStakePools, type StakeOrderable } from "../../lib/stake-pool-order";

const P = (id: string, symbol: string, name = symbol): StakeOrderable => ({ id, symbol, name });

// Incoming order mimics the API's (e.g. TVL-ish); the helper must preserve it
// for non-staked pools and lift staked pools to the top.
const POOLS: StakeOrderable[] = [
  P("cate", "CATE"),
  P("jup", "JUP", "Jupiter"),
  P("sol", "SOL", "Solana"),
  P("pengu", "PENGU"),
  P("solcat", "SOLCAT"),
];

describe("orderStakePools", () => {
  const noStake = () => 0;

  it("empty query keeps every pool in incoming order when nothing is staked", () => {
    expect(orderStakePools(POOLS, "", noStake).map((p) => p.id)).toEqual([
      "cate",
      "jup",
      "sol",
      "pengu",
      "solcat",
    ]);
  });

  it("lifts staked pools to the top, largest stake first", () => {
    const staked = (id: string) => (id === "sol" ? 10000 : id === "pengu" ? 200 : 0);
    expect(orderStakePools(POOLS, "", staked).map((p) => p.id)).toEqual([
      "sol", // $10,000 staked
      "pengu", // $200 staked
      "cate", // rest keep incoming order
      "jup",
      "solcat",
    ]);
  });

  it("non-staked pools keep their incoming order (stable, not engine-dependent)", () => {
    // Only pengu staked → it goes first, the other four stay cate/jup/sol/solcat.
    const staked = (id: string) => (id === "pengu" ? 5 : 0);
    expect(orderStakePools(POOLS, "", staked).map((p) => p.id)).toEqual([
      "pengu",
      "cate",
      "jup",
      "sol",
      "solcat",
    ]);
  });

  it("filters by symbol OR name, case-insensitive", () => {
    expect(orderStakePools(POOLS, "sol", noStake).map((p) => p.id)).toEqual(["sol", "solcat"]);
    // matches on `name` (Jupiter) even though the query isn't in the symbol
    expect(orderStakePools(POOLS, "jupiter", noStake).map((p) => p.id)).toEqual(["jup"]);
  });

  it("search and staked-first combine: staked matches still sort first", () => {
    const staked = (id: string) => (id === "solcat" ? 50 : 0);
    // query "sol" matches SOL + SOLCAT; SOLCAT is staked so it leads.
    expect(orderStakePools(POOLS, "SOL", staked).map((p) => p.id)).toEqual(["solcat", "sol"]);
  });

  it("returns empty when nothing matches", () => {
    expect(orderStakePools(POOLS, "zzz", noStake)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const staked = (id: string) => (id === "sol" ? 1 : 0);
    const before = POOLS.map((p) => p.id);
    orderStakePools(POOLS, "", staked);
    expect(POOLS.map((p) => p.id)).toEqual(before);
  });
});
