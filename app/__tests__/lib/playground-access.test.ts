// @vitest-environment node
/**
 * The playground's VERIFY side of the devnet v2 lock (lib/playground-access.ts),
 * proven byte-compatible with the gate's MINT side on percolator.trade (#2732,
 * copied verbatim into __tests__/fixtures/gate-playground-access.pr2732.ts).
 */
import { describe, expect, it } from "vitest";
import * as gate from "../fixtures/gate-playground-access.pr2732";
import {
  HANDOFF_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  TEAM_SUB_PREFIX,
  accessSecret,
  cohortCutoff,
  gateEnabled,
  isWithinCohort,
  mintSession,
  readHandoff,
  readSession,
  sessionGrantsAccess,
  teamFingerprint,
  teamSecretMatches,
} from "@/lib/playground-access";

const SECRET = "s".repeat(40);
const OTHER = "o".repeat(40);
const TEAM = "t".repeat(40);
const NOW = 1_800_000_000_000;
const ENV = { PLAYGROUND_ACCESS_SECRET: SECRET, PLAYGROUND_TEAM_BYPASS_SECRET: TEAM };

describe("wire contract matches the gate (#2732)", () => {
  it("shares constants", () => {
    expect(HANDOFF_TTL_SECONDS).toBe(gate.HANDOFF_TTL_SECONDS);
    expect(SESSION_TTL_SECONDS).toBe(gate.SESSION_TTL_SECONDS);
    expect(SESSION_COOKIE).toBe(gate.SESSION_COOKIE);
  });

  it("a handoff minted by the gate's Node code verifies here", async () => {
    const t = gate.mintHandoff("8c1f-row-uuid", 812, SECRET, NOW);
    expect(await readHandoff(t, SECRET, NOW)).toEqual({ sub: "8c1f-row-uuid", pos: 812, exp: NOW / 1000 + 90 });
  });

  it("verifies non-ASCII subs identically (utf8 on both sides)", async () => {
    const t = gate.mintHandoff("rów-ü-🙂", 3, SECRET, NOW);
    expect((await readHandoff(t, SECRET, NOW))?.sub).toBe("rów-ü-🙂");
  });

  it("a session minted here is byte-identical to the gate's mintSession", async () => {
    const ours = await mintSession("row-1", 42, SECRET, NOW);
    expect(ours).toBe(gate.mintSession("row-1", 42, SECRET, NOW));
    expect(gate.readSession(ours, SECRET, NOW)).toEqual({ sub: "row-1", pos: 42, exp: NOW / 1000 + SESSION_TTL_SECONDS });
  });

  it("matches across 200 random claims", async () => {
    for (let i = 0; i < 200; i++) {
      const sub = Math.random().toString(36).slice(2) + "-" + i;
      const pos = Math.floor(Math.random() * 5000) + 1;
      const now = NOW + i * 7919;
      expect(await mintSession(sub, pos, SECRET, now)).toBe(gate.mintSession(sub, pos, SECRET, now));
      expect(await readHandoff(gate.mintHandoff(sub, pos, SECRET, now), SECRET, now)).not.toBeNull();
    }
  });
});

describe("handoff verification refuses", () => {
  it("a different secret", async () => {
    expect(await readHandoff(gate.mintHandoff("r", 1, OTHER, NOW), SECRET, NOW)).toBeNull();
  });

  it("a tampered payload (position rewritten to 1)", async () => {
    const t = gate.mintHandoff("r", 5000, SECRET, NOW);
    const [, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "r", pos: 1, exp: NOW / 1000 + 90 })).toString("base64url");
    expect(await readHandoff(`${forged}.${mac}`, SECRET, NOW)).toBeNull();
  });

  it("a tampered signature", async () => {
    const t = gate.mintHandoff("r", 1, SECRET, NOW);
    const flipped = t.slice(0, -1) + (t.endsWith("A") ? "B" : "A");
    expect(await readHandoff(flipped, SECRET, NOW)).toBeNull();
  });

  it("at and after expiry, but not one second before", async () => {
    const t = gate.mintHandoff("r", 1, SECRET, NOW);
    expect(await readHandoff(t, SECRET, NOW + 89_999)).not.toBeNull();
    expect(await readHandoff(t, SECRET, NOW + 90_000)).toBeNull();
    expect(await readHandoff(t, SECRET, NOW + 3_600_000)).toBeNull();
  });

  it("a SESSION presented as a handoff", async () => {
    expect(await readHandoff(gate.mintSession("r", 1, SECRET, NOW), SECRET, NOW)).toBeNull();
    expect(await readHandoff(await mintSession("r", 1, SECRET, NOW), SECRET, NOW)).toBeNull();
  });

  it("a HANDOFF presented as a session", async () => {
    expect(await readSession(gate.mintHandoff("r", 1, SECRET, NOW), SECRET, NOW)).toBeNull();
  });

  it("garbage, empty and structurally wrong input without throwing", async () => {
    for (const t of [null, undefined, "", ".", "a.", ".b", "no-dot", "a.b.c", "%%%.%%%", "x".repeat(5000)]) {
      expect(await readHandoff(t as string, SECRET, NOW)).toBeNull();
    }
  });

  it("validly-signed claims of the wrong shape", async () => {
    // Sign arbitrary bodies with the real derivation via the gate's mint internals.
    const { createHmac } = await import("node:crypto");
    const sign = (claims: unknown) => {
      const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${body}.${createHmac("sha256", `${SECRET}:handoff:v1`).update(body).digest("base64url")}`;
    };
    expect(await readHandoff(sign({ sub: "r", pos: 1, exp: NOW / 1000 + 60 }), SECRET, NOW)).not.toBeNull(); // control
    expect(await readHandoff(sign({ sub: "", pos: 1, exp: NOW / 1000 + 60 }), SECRET, NOW)).toBeNull();
    expect(await readHandoff(sign({ sub: 7, pos: 1, exp: NOW / 1000 + 60 }), SECRET, NOW)).toBeNull();
    expect(await readHandoff(sign({ sub: "r", pos: "1", exp: NOW / 1000 + 60 }), SECRET, NOW)).toBeNull();
    expect(await readHandoff(sign({ sub: "r", pos: 1 }), SECRET, NOW)).toBeNull();
  });
});

describe("sessionGrantsAccess", () => {
  it("grants a fresh in-cohort session", async () => {
    expect(await sessionGrantsAccess(await mintSession("row", 1000, SECRET, NOW), ENV, NOW)).toBe(true);
  });

  it("refuses over the cutoff, and honours a lowered cutoff on the next request", async () => {
    const s = await mintSession("row", 900, SECRET, NOW);
    expect(await sessionGrantsAccess(await mintSession("row", 1001, SECRET, NOW), ENV, NOW)).toBe(false);
    expect(await sessionGrantsAccess(s, { ...ENV, PLAYGROUND_COHORT_CUTOFF: "500" }, NOW)).toBe(false);
  });

  it("refuses an expired session", async () => {
    const s = await mintSession("row", 1, SECRET, NOW);
    expect(await sessionGrantsAccess(s, ENV, NOW + SESSION_TTL_SECONDS * 1000)).toBe(false);
  });

  it("refuses everything when the access secret is unset or short (fail closed)", async () => {
    const s = await mintSession("row", 1, SECRET, NOW);
    expect(await sessionGrantsAccess(s, {}, NOW)).toBe(false);
    expect(await sessionGrantsAccess(s, { PLAYGROUND_ACCESS_SECRET: "short" }, NOW)).toBe(false);
    // No substitute key either: a cookie an attacker signs with an empty / the short base is refused.
    expect(await sessionGrantsAccess(await mintSession("row", 1, "", NOW), {}, NOW)).toBe(false);
    expect(await sessionGrantsAccess(await mintSession("row", 1, "short", NOW), { PLAYGROUND_ACCESS_SECRET: "short" }, NOW)).toBe(false);
  });

  it("team sessions die when the team secret rotates or is unset", async () => {
    const sub = TEAM_SUB_PREFIX + (await teamFingerprint(TEAM));
    const s = await mintSession(sub, 1, SECRET, NOW);
    expect(await sessionGrantsAccess(s, ENV, NOW)).toBe(true);
    expect(await sessionGrantsAccess(s, { ...ENV, PLAYGROUND_TEAM_BYPASS_SECRET: "r".repeat(40) }, NOW)).toBe(false);
    expect(await sessionGrantsAccess(s, { PLAYGROUND_ACCESS_SECRET: SECRET }, NOW)).toBe(false);
  });
});

describe("helpers", () => {
  it("cohort bounds and default cutoff of 1000", () => {
    expect(cohortCutoff(undefined)).toBe(1000);
    expect(cohortCutoff("abc")).toBe(1000);
    expect(cohortCutoff("250")).toBe(250);
    expect(isWithinCohort(1, 1000)).toBe(true);
    expect(isWithinCohort(1000, 1000)).toBe(true);
    expect(isWithinCohort(1001, 1000)).toBe(false);
    expect(isWithinCohort(0, 1000)).toBe(false);
    expect(isWithinCohort(null, 1000)).toBe(false);
  });

  it("gate is on only for exactly 'true'", () => {
    expect(gateEnabled({})).toBe(false);
    expect(gateEnabled({ PLAYGROUND_GATE_ENABLED: "false" })).toBe(false);
    expect(gateEnabled({ PLAYGROUND_GATE_ENABLED: "1" })).toBe(false);
    expect(gateEnabled({ PLAYGROUND_GATE_ENABLED: "true" })).toBe(true);
  });

  it("secrets need >= 32 chars", () => {
    expect(accessSecret({ PLAYGROUND_ACCESS_SECRET: "x".repeat(31) })).toBeNull();
    expect(accessSecret({ PLAYGROUND_ACCESS_SECRET: SECRET })).toBe(SECRET);
  });

  it("team secret compare", async () => {
    expect(await teamSecretMatches(TEAM, TEAM)).toBe(true);
    expect(await teamSecretMatches(TEAM + "x", TEAM)).toBe(false);
    expect(await teamSecretMatches("", TEAM)).toBe(false);
    expect(await teamSecretMatches(null, TEAM)).toBe(false);
  });
});
