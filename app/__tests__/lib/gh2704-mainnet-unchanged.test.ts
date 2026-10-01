/**
 * GH#2704 follow-up: the devnet pin must not change getNetwork() anywhere else.
 * `preFixGetNetwork` is the trunk implementation before #2713, copied verbatim.
 * For every deployment value other than "devnet" (mainnet, unset, blank, junk)
 * and every stored override, the new getNetwork() must match it exactly.
 * Only a devnet deployment with a stored "mainnet" override may differ.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getNetwork, getConfig } from "@/lib/config";

type Network = "mainnet" | "devnet";
const KEY = "percolator-network";

function preFixGetNetwork(): Network {
  const deploymentNet = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim();
  if (deploymentNet === "mainnet") return "mainnet";
  if (typeof window !== "undefined") {
    try {
      const override = localStorage.getItem(KEY) as Network | null;
      if (override === "mainnet" || override === "devnet") return override;
    } catch {
      // ignore
    }
  }
  if (deploymentNet === "devnet") return "devnet";
  return "mainnet";
}

const DEPLOYMENTS = ["mainnet", " mainnet ", undefined, "", "staging"] as const;
const OVERRIDES = [null, "mainnet", "devnet", "garbage"] as const;

function setup(dep: string | undefined, ov: string | null) {
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", dep as unknown as string);
  localStorage.clear();
  if (ov !== null) localStorage.setItem(KEY, ov);
}

describe("GH#2704: non-devnet deployments behave exactly as before", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  for (const dep of DEPLOYMENTS) {
    for (const ov of OVERRIDES) {
      it(`deployment=${JSON.stringify(dep)} override=${JSON.stringify(ov)}`, () => {
        setup(dep, ov);
        expect(getNetwork()).toBe(preFixGetNetwork());
      });
    }
  }

  it("a mainnet build resolves to mainnet config for every stored override", () => {
    setup("mainnet", null);
    const baseline = getConfig();
    expect(baseline.network).toBe("mainnet");
    for (const ov of OVERRIDES) {
      setup("mainnet", ov);
      expect(getNetwork()).toBe("mainnet");
      expect(getConfig()).toEqual(baseline);
    }
  });

  it("a devnet build differs from before only for a stored mainnet override", () => {
    for (const ov of OVERRIDES) {
      setup("devnet", ov);
      expect(getNetwork()).toBe("devnet");
      if (ov !== "mainnet") expect(getNetwork()).toBe(preFixGetNetwork());
    }
  });
});
