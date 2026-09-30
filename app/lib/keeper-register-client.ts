/**
 * UX WP-7 (audit §3.15, WZ-2): registering the new market's live price, automatically, with NO
 * signature. The proof is the market-creation transaction itself (lib/keeper-register-memo.ts), so
 * the app can retry in the background for as long as the page is open:
 *   attempt now, then after 5, 10, 20, 40, 60, 60 s, then every 2 min.
 * Status copy: "Connecting the live price… usually under a minute."; after 5 min: "Your market is
 * created but its live price isn't connected yet. We'll keep trying; you can close this page."
 * SECURITY REVIEW REQUIRED before merge (replaces the signed-message registration).
 */
import type { MarketRegistrationPayload } from "@/lib/market-registration-auth";

export const KEEPER_REGISTER_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000] as const;
export const KEEPER_REGISTER_STEADY_MS = 120_000;
export const KEEPER_REGISTER_SLOW_AFTER_MS = 5 * 60_000;

export const KEEPER_REGISTER_COPY = {
  connecting: "Connecting the live price… usually under a minute.",
  slow: "Your market is created but its live price isn't connected yet. We'll keep trying; you can close this page.",
  ready: "Live price connected.",
  tryNow: "Try now",
  almostReady: "Almost ready",
  noProof: "This market's creation transaction isn't known on this device, so the live price can't be connected from here.",
} as const;

export interface KeeperRegisterRequest {
  slabAddress: string;
  mainnetCA?: string | null;
  dexPoolAddress: string;
  /** Already normalized to the keeper vocabulary (the memo binds exactly what is sent). */
  dexType?: string | null;
  symbol?: string | null;
  payload?: MarketRegistrationPayload | null;
  /** The market-creation (M1) transaction signature: the registration proof. */
  proofTx: string;
}

export interface KeeperRegisterAttempt {
  registered: boolean;
  /** Worth retrying (not landed yet, RPC or server trouble). A 400 / 403 is final. */
  retryable: boolean;
  message: string;
}

export async function postKeeperRegistration(req: KeeperRegisterRequest, fetchImpl: typeof fetch = fetch): Promise<KeeperRegisterAttempt> {
  try {
    const r = await fetchImpl("/api/playground/keeper-register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slabAddress: req.slabAddress,
        mainnetCA: req.mainnetCA ?? null,
        dexPoolAddress: req.dexPoolAddress,
        dexType: req.dexType ?? null,
        symbol: req.symbol ?? null,
        payload: req.payload ?? null,
        proofTx: req.proofTx,
      }),
    });
    const body = (await r.json().catch(() => ({}))) as { registered?: boolean; error?: string; message?: string };
    if (r.ok && body.registered) return { registered: true, retryable: false, message: KEEPER_REGISTER_COPY.ready };
    const retryable = r.status === 409 || r.status === 429 || r.status >= 500;
    return { registered: false, retryable, message: body.error ?? body.message ?? `HTTP ${r.status}` };
  } catch (e) {
    return { registered: false, retryable: true, message: e instanceof Error ? e.message : String(e) };
  }
}

export type KeeperRegisterPhase = "connecting" | "slow" | "ready" | "failed";

export interface KeeperRegisterLoopDeps {
  attempt: () => Promise<KeeperRegisterAttempt>;
  onStatus: (s: { phase: KeeperRegisterPhase; message: string; attempts: number }) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });

/** The background loop. Resolves with the final phase ("ready" / "failed", or the last one on abort). */
export async function runKeeperRegistration(d: KeeperRegisterLoopDeps): Promise<KeeperRegisterPhase> {
  const sleep = d.sleep ?? defaultSleep;
  const now = d.now ?? Date.now;
  const t0 = now();
  let phase: KeeperRegisterPhase = "connecting";
  for (let i = 0; ; i++) {
    if (d.signal?.aborted) return phase;
    const r = await d.attempt();
    if (r.registered) {
      d.onStatus({ phase: "ready", message: KEEPER_REGISTER_COPY.ready, attempts: i + 1 });
      return "ready";
    }
    if (!r.retryable) {
      d.onStatus({ phase: "failed", message: r.message, attempts: i + 1 });
      return "failed";
    }
    phase = now() - t0 >= KEEPER_REGISTER_SLOW_AFTER_MS ? "slow" : "connecting";
    d.onStatus({ phase, message: phase === "slow" ? KEEPER_REGISTER_COPY.slow : KEEPER_REGISTER_COPY.connecting, attempts: i + 1 });
    await sleep(i < KEEPER_REGISTER_BACKOFF_MS.length ? KEEPER_REGISTER_BACKOFF_MS[i] : KEEPER_REGISTER_STEADY_MS, d.signal);
  }
}

const PROOF_KEY = (slab: string) => `perc.keeperProofTx.${slab}`;

/** The creation tx per market, so "Try now" works after a reload on this device. */
export function saveProofTx(slab: string, sig: string): void {
  try {
    window.localStorage.setItem(PROOF_KEY(slab), sig);
  } catch {
    /* private mode: the in-memory loop still has it */
  }
}
export function loadProofTx(slab: string): string | null {
  try {
    return window.localStorage.getItem(PROOF_KEY(slab));
  } catch {
    return null;
  }
}
