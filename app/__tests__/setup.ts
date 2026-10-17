import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest';
import '@testing-library/jest-dom';
import { __setDevnetV22ForTest } from '@/lib/v22/flag';
import { __setDevnetV21ForTest } from '@/lib/v21/flag';
import { __setUnknownLotExpForTest } from '@/lib/v22/lot-registry';
import { QUARANTINED_FILES, QUARANTINED_TESTS, LOT0_TESTS } from './v21-contract-pins';

// Flag-on runs (NEXT_PUBLIC_DEVNET_V22=1, scripts/flag-on-delta.mjs). See v21-contract-pins.ts: QUARANTINED entries rerun with the
// v2.2 and v2.1 flags pinned OFF, LOT0 entries run flag ON with lot exponent 0 seeded. Anything else runs flag ON unchanged and fails
// if it fails. Flag off this block does nothing. The quarantine size is printed at the start of every flag-on run (global-setup.ts).
{
  const envOn = process.env.NEXT_PUBLIC_DEVNET_V22 === '1' || process.env.NEXT_PUBLIC_DEVNET_V22 === 'true';
  const testPath = (expect.getState().testPath ?? '').replace(/^.*\/app\//, '');
  if (envOn && QUARANTINED_FILES.some(([f]) => f === testPath)) {
    // Whole-file quarantine: drop the env vars too (files that vi.resetModules() re-evaluate the flag module and would read them again).
    const prev = process.env.NEXT_PUBLIC_DEVNET_V22;
    const prev21 = process.env.NEXT_PUBLIC_DEVNET_V21;
    delete process.env.NEXT_PUBLIC_DEVNET_V22;
    delete process.env.NEXT_PUBLIC_DEVNET_V21;
    __setDevnetV22ForTest(false);
    __setDevnetV21ForTest(false);
    afterAll(() => {
      process.env.NEXT_PUBLIC_DEVNET_V22 = prev;
      if (prev21 === undefined) delete process.env.NEXT_PUBLIC_DEVNET_V21; else process.env.NEXT_PUBLIC_DEVNET_V21 = prev21;
    });
  }
  if (envOn) {
    const quarantined = new Set(QUARANTINED_TESTS.filter(([f]) => f === testPath).map(([, n]) => n));
    const lot0 = new Set(LOT0_TESTS.filter(([f]) => f === testPath).map(([, n]) => n));
    if (quarantined.size > 0 || lot0.size > 0) {
      beforeEach(() => {
        const name = (expect.getState().currentTestName ?? '').replace(/ > /g, ' ');
        if (quarantined.has(name)) { __setDevnetV22ForTest(false); __setDevnetV21ForTest(false); }
        if (lot0.has(name)) __setUnknownLotExpForTest(0);
      });
      afterEach(() => { __setDevnetV22ForTest(null); __setDevnetV21ForTest(null); __setUnknownLotExpForTest(null); });
    }
  }
}

// keeper-register re-reads a not-yet-visible creation tx in-request (app/api/playground/keeper-register);
// tests must not sleep through that grace. The route's own tests set it explicitly when they exercise it.
process.env.KEEPER_REGISTER_PROOF_POLL_MS ??= '0';

// jsdom doesn't implement window.matchMedia — mock it so hooks like
// usePrefersReducedMotion don't throw during component tests.
//
// Guarded by `typeof window !== 'undefined'`: this setup file runs for EVERY
// test file regardless of that file's own `@vitest-environment` docblock
// (setupFiles is a global config, not per-environment). A handful of
// server-route tests (e.g. __tests__/api/market-logo-ownership-auth.test.ts)
// opt into `@vitest-environment node` — real Next.js API routes only ever
// run in Node, and jsdom's realm-separated `TextEncoder`/`Uint8Array` makes
// tweetnacl's `instanceof Uint8Array` check spuriously fail there (a
// test-environment artifact, not a product bug) — so `window` doesn't exist
// for them.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// ── Web Storage polyfill ──────────────────────────────────────────────────────
//
// Under this jsdom setup `window.localStorage` is a PLAIN EMPTY OBJECT — no
// getItem, no setItem, no clear (verified: its prototype is Object.prototype).
// So every test touching storage died on the first call, which is why the whole
// useChartDrawings / useChartDrawingTool suites failed as a block (29 tests)
// with `window.localStorage.clear is not a function`. That is one missing
// global, not 29 broken behaviours.
//
// Methods are defined as OWN, writable, configurable properties so tests can
// still `vi.spyOn(window.localStorage, "setItem")` — several deliberately do,
// to simulate a quota error or Safari Private Mode throwing on read.
// Methods live on a shared PROTOTYPE, not on the instance, because the suites
// spy via `vi.spyOn(window.localStorage.__proto__, "setItem")` — which is also
// how real jsdom behaves (every Storage shares Storage.prototype). Putting them
// on the instance makes the prototype empty and spyOn throws
// "The property setItem is not defined on the object".
const storageBacking = new WeakMap<object, Map<string, string>>();

class MemoryStorage {
  constructor() {
    storageBacking.set(this, new Map());
  }
  private get map(): Map<string, string> {
    let m = storageBacking.get(this);
    if (!m) { m = new Map(); storageBacking.set(this, m); }
    return m;
  }
  getItem(key: string): string | null {
    const v = this.map.get(String(key));
    return v === undefined ? null : v;
  }
  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.map.delete(String(key));
  }
  clear(): void {
    this.map.clear();
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

function createStorage(): Storage {
  return new MemoryStorage() as unknown as Storage;
}

// Guarded: some suites opt into `@vitest-environment node`, where `window` does
// not exist. Touching it unconditionally here throws ReferenceError during
// setup and fails those files before their first test runs.
const hasWindow = typeof window !== "undefined";
for (const name of ["localStorage", "sessionStorage"] as const) {
  const impl = createStorage();
  if (hasWindow) {
    Object.defineProperty(window, name, { value: impl, writable: true, configurable: true });
  }
  // jsdom's window is not always the same object the module under test closes
  // over, so mirror onto globalThis too (and in node this is the only target).
  Object.defineProperty(globalThis, name, { value: impl, writable: true, configurable: true });
}

// Cleanup after each test
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
