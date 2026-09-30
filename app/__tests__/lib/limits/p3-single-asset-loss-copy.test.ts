/**
 * 58e379f1 (P3 FINAL): F14-Q2 single-asset markets + error 86, the user's loss decision in copy,
 * and the junior's resolved 102 builder the creator panel and the BPF sim share.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import { COPY, P3_ERROR_COPY_BY_NAME, p3ErrorCopyByCode } from "@/lib/limits/copy";
import { limitsErrorCopy, p3LimitsErrorCopy } from "@/lib/limits/errors";
import { parseMarketCreationError } from "@/lib/parseMarketError";
import {
  buildJuniorResolvedReleaseIxs,
  juniorReleaseNeedsHarvest,
  juniorResolvedReleasableAtoms,
} from "@/lib/limits/junior-resolved-release";

describe("error 86 VaultLpMultiAssetMarket", () => {
  it("is in the one constants module at 86 and has clear copy", () => {
    expect(C.P3_ERR.VaultLpMultiAssetMarket).toBe(86);
    const copy = p3ErrorCopyByCode()[86];
    expect(copy).toBe(P3_ERROR_COPY_BY_NAME.VaultLpMultiAssetMarket);
    expect(copy).toMatch(/single-asset market/);
    expect(p3LimitsErrorCopy(86)).toBe(copy);
  });
  it("routes from a wrapper failure when P3 is on, and not when it is off", () => {
    const base = { code: 86, originProgramId: "W", wrapperId: "W", matcherId: "M" };
    expect(limitsErrorCopy({ ...base, p3Enabled: true })).toBe(P3_ERROR_COPY_BY_NAME.VaultLpMultiAssetMarket);
    expect(limitsErrorCopy({ ...base, p3Enabled: false })).toBeNull();
    // A matcher-origin 86 is not ours.
    expect(limitsErrorCopy({ ...base, originProgramId: "M", p3Enabled: true })).toBeNull();
  });
  it("the wizard's vault-lp step explains it (retrying this market cannot help)", () => {
    const hexForm = parseMarketCreationError(new Error("Program W failed: custom program error: 0x56"), { step: "vault-lp" });
    const jsonForm = parseMarketCreationError(new Error('{"InstructionError":[4,{"Custom":86}]}'), { step: "vault-lp" });
    for (const m of [hexForm, jsonForm]) {
      expect(m).toMatch(/more than one asset slot/);
      expect(m).toMatch(/single-asset markets/);
    }
  });
});

describe("loss copy: a loss beyond the junior is a haircut on the winner's profit; seniors whole", () => {
  const HAIRCUT = /haircut on the winning traders' profit/;
  const WHOLE = /Earn depositors stay whole|not on Earn deposits|Earn deposits stay whole/;
  it("every P3 'who bears losses' string says it", () => {
    for (const s of [COPY.wizardRequirement("20%"), COPY.p3Wizard.explain, COPY.earnRiskP3, COPY.juniorExhausted]) {
      expect(s).toMatch(HAIRCUT);
      expect(s).toMatch(WHOLE);
    }
  });
  it("no P3 surface claims Earn depositors pay trader profits or lose after the junior", () => {
    const WRONG = /paid by Earn depositors|before Earn depositors lose|Earn depositors lose|further trader profits are paid/;
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (typeof v === "function") strings.push(String((v as (...a: string[]) => string)("X", "Y", "Z", "W")));
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(COPY);
    walk(P3_ERROR_COPY_BY_NAME);
    for (const f of ["components/limits/CreatorLimits.tsx", "components/limits/EarnTrancheCard.tsx", "components/earn/EarnVaultView.tsx"]) {
      strings.push(readFileSync(resolve(process.cwd(), f), "utf8"));
    }
    for (const s of strings) expect(s).not.toMatch(WRONG);
    const creator = readFileSync(resolve(process.cwd(), "components/limits/CreatorLimits.tsx"), "utf8");
    expect(creator).toContain("{COPY.juniorExhausted}");
    const card = readFileSync(resolve(process.cwd(), "components/limits/EarnTrancheCard.tsx"), "utf8");
    expect(card).toMatch(HAIRCUT);
    const earn = readFileSync(resolve(process.cwd(), "components/earn/EarnVaultView.tsx"), "utf8");
    expect(earn).toContain("COPY.earnRiskP3");
  });
});

describe("junior resolved release (102): physical - C, 78 first when pending", () => {
  // A market with only the fields decodeTerminalBacking / decodeMarketEngineView read.
  function market(o: { physicalLong: bigint; physicalShort: bigint; vault: bigint; cTot: bigint }): Uint8Array {
    const d = new Uint8Array(C.assetEngineOff(1) + 64);
    const dv = new DataView(d.buffer);
    const put = (off: number, v: bigint) => {
      dv.setBigUint64(off, v & ((1n << 64n) - 1n), true);
      dv.setBigUint64(off + 8, v >> 64n, true);
    };
    dv.setBigUint64(0, C.WRAPPER_MAGIC, true);
    dv.setUint16(8, C.WRAPPER_VERSION_V18, true);
    d[C.HEADER_KIND_OFF] = C.KIND_MARKET_ACCOUNT;
    const g = C.MARKET_GROUP_OFF;
    put(g + C.H_VAULT, o.vault);
    put(g + C.H_C_TOT, o.cTot);
    put(C.assetEngineOff(0) + C.SLOT_BACKING_LONG + C.BUCKET_FRESH_UNLIENED_BACKING_NUM, o.physicalLong * C.BOUND_SCALE + 7n);
    put(C.assetEngineOff(0) + C.SLOT_BACKING_SHORT + C.BUCKET_FRESH_UNLIENED_BACKING_NUM, o.physicalShort * C.BOUND_SCALE);
    return d;
  }
  it("releasable = physical (both domains) - C, floored at 0", () => {
    const m = market({ physicalLong: 60_001_007n, physicalShort: 0n, vault: 60_001_007n, cTot: 0n });
    expect(juniorResolvedReleasableAtoms(m, 0, 1_007n)).toBe(60_000_000n);
    expect(juniorResolvedReleasableAtoms(m, 1, 1_007n)).toBe(60_000_000n); // sibling domain reads the same pair
    expect(juniorResolvedReleasableAtoms(m, 0, 70_000_000n)).toBe(0n);
    const both = market({ physicalLong: 10n, physicalShort: 5n, vault: 15n, cTot: 0n });
    expect(juniorResolvedReleasableAtoms(both, 0, 3n)).toBe(12n);
  });
  it("needs 78 first iff a claim-free residual is pending (vault > owned)", () => {
    expect(juniorReleaseNeedsHarvest(market({ physicalLong: 1n, physicalShort: 0n, vault: 100n, cTot: 100n }), 0)).toBe(false);
    expect(juniorReleaseNeedsHarvest(market({ physicalLong: 1n, physicalShort: 0n, vault: 101n, cTot: 100n }), 0)).toBe(true);
  });
  it("builds [ATA, 102 + resolved tail] or [ATA, 78, 102] in that order", () => {
    const k = () => Keypair.generate().publicKey;
    const vm = { programId: k(), market: k(), registry: k(), vaultLpState: k(), lpPortfolio: k(), ledger: k(), siblingLedger: k() };
    const c = { vm, domain: 0, owner: k(), ownerAta: k(), mint: k(), vaultToken: k(), vaultAuthority: k() };
    const plain = buildJuniorResolvedReleaseIxs(c, 5n, false);
    expect(plain).toHaveLength(2);
    expect(plain[1].data[0]).toBe(C.P3_TAG.VaultLpReleaseSurplus);
    expect(plain[1].keys).toHaveLength(11);
    expect(plain[1].keys[7].pubkey.equals(c.ownerAta)).toBe(true);
    expect(plain[1].keys[0].pubkey.equals(c.owner) && plain[1].keys[0].isSigner).toBe(true);
    const withHarvest = buildJuniorResolvedReleaseIxs(c, 5n, true);
    expect(withHarvest.map((i) => i.data[0])).toEqual([1, C.TAG_LP_VAULT_CRANK_FEES, C.P3_TAG.VaultLpReleaseSurplus]);
  });
  it("null-safe on missing market data", () => {
    expect(juniorResolvedReleasableAtoms(null, 0, 0n)).toBeNull();
    expect(juniorReleaseNeedsHarvest(null, 0)).toBe(false);
  });
  it("the creator panel and the hook both go through this module", () => {
    const hook = readFileSync(resolve(process.cwd(), "hooks/useJuniorTranche.ts"), "utf8");
    const panel = readFileSync(resolve(process.cwd(), "components/limits/CreatorLimits.tsx"), "utf8");
    expect(hook).toContain("buildJuniorResolvedReleaseIxs(c, amount, juniorReleaseNeedsHarvest(c.marketData, c.domain))");
    expect(panel).toContain("juniorResolvedReleasableAtoms(");
  });
});
