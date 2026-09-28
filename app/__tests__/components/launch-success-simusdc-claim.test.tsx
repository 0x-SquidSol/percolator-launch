/**
 * GH#2610 — the launch success screen must not carry a Sim-USDC claim it cannot
 * report on.
 *
 * The app used to fire a background POST to /api/devnet-airdrop after every
 * market creation. It was the FOURTH way to do one thing — the "GET SIM-USDC &
 * TRADE" button on this same screen fires the identical request, and there is a
 * trade-page faucet and a /faucet page — and the only one that could put an
 * error on the launch screen. It failed on every launch (#2608, cause only in
 * Sentry), producing three separate defects:
 *
 *   1. the server's reason was captured in `devnetMintError` and never printed;
 *   2. a 429 (which the route returns for the per-IP limiter as well as "already
 *      claimed") left a "Sending Sim-USDC…" spinner that never resolved;
 *   3. the button's own failure was set and then navigated past, so it was
 *      invisible too.
 *
 * The automatic claim is gone. The button keeps the job and now reports its
 * outcome. These tests pin the new behaviour and, where it matters, that the old
 * states can no longer be reached.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const push = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/config", () => ({ getNetwork: () => "devnet" }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: { toBase58: () => "WaLLet1111111111111111111111111111111111111" } }),
}));
vi.mock("@/components/create/LogoUpload", () => ({ LogoUpload: () => null }));

import { LaunchSuccess } from "@/components/create/LaunchSuccess";

const SIM_USDC = "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs";
const MARKET = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";

type Props = Parameters<typeof LaunchSuccess>[0];
function props(over: Partial<Props> = {}): Props {
  return {
    tokenSymbol: "CATE",
    tradingFeeBps: 5,
    maxLeverage: 5,
    marketAddress: MARKET,
    txSigs: [],
    onDeployAnother: () => {},
    devnetMint: SIM_USDC,
    ...over,
  } as Props;
}

const failingFetch = () =>
  vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "Internal server error" }) });
const okFetch = () =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ amount: 500, symbol: "Sim-USDC" }) });

beforeEach(() => {
  push.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("the screen no longer reports on a claim it does not make", () => {
  it("shows a plain statement, not a claim outcome", () => {
    render(<LaunchSuccess {...props()} />);

    expect(screen.getByText(/is your collateral/i)).toBeInTheDocument();
    // The three states that came from the automatic claim are all unreachable.
    expect(screen.queryByText(/Sending Sim-USDC/i)).toBeNull();
    expect(screen.queryByText(/Sim-USDC claim failed/i)).toBeNull();
  });

  it("does not fall through to a permanent spinner", () => {
    // THE regression that removing the claim would otherwise have introduced.
    // The old panel was a three-way branch on the automatic claim's outcome —
    // sent / failed / in-progress. With no automatic claim nothing sets the
    // first two, so it would have landed on the in-progress arm on EVERY launch
    // and never resolved.
    render(<LaunchSuccess {...props()} />);

    expect(screen.queryByText(/Sending Sim-USDC/i)).toBeNull();
    expect(screen.getByText(/is your collateral/i)).toBeInTheDocument();
  });

  it("the state that fed that branch is gone, not just unset", () => {
    // Stronger than rendering with the props null: the props do not exist, so
    // the branch cannot be reintroduced by a caller passing them again. Asserted
    // on source because a deleted prop has no runtime surface to probe — and on
    // all three files, because the wizard threading them through was what kept
    // them alive. tsc is the backstop: a re-added prop with no declaration fails
    // the build.
    const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");
    for (const f of [
      "components/create/LaunchSuccess.tsx",
      "components/create/CreateMarketWizard.tsx",
      "hooks/useCreateMarket.ts",
    ]) {
      const src = read(f);
      // Matched on the punctuation that makes a name CODE rather than prose, so
      // the historical comments explaining the removal are still allowed to name
      // them: `x?:` / `x:` declare, `x=` passes as a JSX prop, `x,` destructures.
      // This is deliberately not a comment-stripping pass — that would make the
      // test's own parsing the thing most likely to be wrong.
      for (const name of ["devnetAirdropAmount", "devnetAirdropSymbol", "devnetMintError"]) {
        for (const suffix of ["?:", ":", "=", ","]) {
          expect(src).not.toContain(name + suffix);
        }
      }
      // CONTROL: the very same shapes ARE found for `devnetMint`, the prop that
      // survives and is load-bearing in all three files — so the assertions
      // above are a real absence, not a probe that can never match anything.
      // (Which suffix differs per file: `?:` in the props type, `=` in the
      // wizard's JSX, `:` in the hook's state — so one-of, not all-of.)
      expect(["?:", ":", "=", ","].some((sfx) => src.includes("devnetMint" + sfx))).toBe(true);
      expect(src.length).toBeGreaterThan(1_000);
    }
  });

  it("the hook's devnet branch issues no request at all", () => {
    // NOT `expect(hook).not.toContain('fetch("/api/devnet-airdrop"')`. That was
    // the first version and it is close to worthless: it greps a 190k-char file
    // for one contiguous literal, so restoring the claim as
    //   const AIRDROP = "/api/devnet" + "-airdrop"; void fetch(AIRDROP, …)
    // passes. So does a template with an interpolation, an imported constant, or
    // a URL built in lib/. A mutant written to match the assertion (a plain
    // literal fetch) dies; the cheaper sibling lives — which makes the kill a
    // measure of the mutant, not of the test.
    //
    // Scoped to the construct instead: the devnet branch that sets devnetMint on
    // each launch path, and nothing else in this 5k-line hook.
    //
    // Anchored on the ASSIGNMENTS and walked outwards to the enclosing block,
    // not on the guard's text. The first version looked for `if (isDevnetEnv) {`
    // and found only one of the two sites — the batch path guards on
    // `isDevnetEnv`, the sequential path on a locally-computed
    // `isDevnet && slabAddr`. The length control below is what caught that.
    const hook = readFileSync(resolve(process.cwd(), "hooks/useCreateMarket.ts"), "utf8");

    // Walks out one level from `from`, returning [openIndex, block].
    const outward = (from: number): [number, string] => {
      let depth = 0;
      let start = -1;
      for (let i = from; i >= 0; i--) {
        if (hook[i] === "}") depth++;
        else if (hook[i] === "{" && depth-- === 0) { start = i; break; }
      }
      expect(start).toBeGreaterThan(-1);
      depth = 0;
      let end = start;
      for (let i = start; i < hook.length; i++) {
        if (hook[i] === "{") depth++;
        else if (hook[i] === "}" && --depth === 0) { end = i; break; }
      }
      return [start, hook.slice(start, end + 1)];
    };

    // The innermost enclosing brace is the `{ ...st, devnetMint }` object literal
    // inside setState, so widen until the block is the devnet branch. The test is
    // the block's OWN GUARD — the text right before its `{` — not whether the
    // block merely contains a devnet `if` somewhere: that first version widened
    // straight out to a 45k-char function, which contains one. The length control
    // below is what caught that.
    const GUARD = /if \([^)]*isDevnet[^)]*\)\s*$/;
    const enclosingBlock = (needle: string): string => {
      const at = hook.indexOf(needle);
      expect(at).toBeGreaterThan(-1);
      let [open, block] = outward(at);
      for (let lvl = 0; lvl < 6 && !GUARD.test(hook.slice(Math.max(0, open - 200), open)); lvl++) {
        [open, block] = outward(open - 1);
      }
      return block;
    };

    const blocks = [
      enclosingBlock("devnetMint: params.mint.toBase58()"),
      enclosingBlock("devnetMint: mintAddr"),
    ];

    for (const body of blocks) {
      // CONTROL: the extracted block is a real, bounded devnet branch — not the
      // whole file and not a stray inner block that happens to exclude a fetch.
      // Without this, a brace-walk bug quietly turns every assertion below into a
      // check on the wrong text, which is how both earlier versions went wrong.
      expect(body.startsWith("{")).toBe(true);
      expect(body.length).toBeLessThan(2_000);
      expect(hook.length).toBeGreaterThan(50_000);

      expect(body).not.toContain("fetch");
      expect(body).not.toContain("await");
      // The branch does exactly one thing.
      expect(body).toContain("devnetMint:");
    }

    // And devnetMint is still assigned a real value on both paths. Anchored on
    // the ASSIGNMENT, not the type declaration: `devnetMint:` alone also matches
    // the interface field and the two `devnetMint: null` initial states, so
    // deleting both setState calls — removing the panel AND the claim button —
    // would have survived.
    expect(hook).toContain("devnetMint: params.mint.toBase58()");
    expect(hook).toContain("devnetMint: mintAddr");
  });
});

describe("the button keeps the job, and reports how it went", () => {
  it("still claims on click, using the same endpoint and mint", async () => {
    const f = failingFetch();
    vi.stubGlobal("fetch", f);

    render(<LaunchSuccess {...props()} />);
    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));

    await waitFor(() => expect(f).toHaveBeenCalled());
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/devnet-airdrop");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ mintAddress: SIM_USDC });
  });

  it("on failure it shows the server's reason instead of navigating past it", async () => {
    const f = failingFetch();
    vi.stubGlobal("fetch", f);

    render(<LaunchSuccess {...props()} />);
    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));

    // The real text, not a fixed sentence.
    await waitFor(() => expect(screen.getByText(/Internal server error/i)).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
  });

  it("a visible failure is not a dead end", async () => {
    // GH#1266 made the navigation unconditional so a failed claim could not
    // strand the user. That concern is preserved by an explicit way forward,
    // rather than by navigating before the message can render.
    const f = failingFetch();
    vi.stubGlobal("fetch", f);

    render(<LaunchSuccess {...props()} />);
    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));

    const toMarket = await screen.findByText(/Continue to the market anyway/i);
    expect(toMarket.closest("a")).toHaveAttribute("href", `/trade/${MARKET}`);

    // And a route that is not the one that just failed: the trade page's faucet
    // button calls the same /api/devnet-airdrop.
    const toFaucet = screen.getByText(/Get Sim-USDC from the faucet/i);
    expect(toFaucet.closest("a")).toHaveAttribute("href", "/faucet");
  });

  it("CONTROL: a successful claim still navigates, exactly as before", async () => {
    // Without this, "never navigate" would pass the failure tests and break the
    // happy path.
    vi.stubGlobal("fetch", okFetch());

    render(<LaunchSuccess {...props()} />);
    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/trade/${MARKET}`));
    expect(screen.queryByText(/Internal server error/i)).toBeNull();
  });

  it("CONTROL: a 429 is treated as success and navigates", async () => {
    // "Already claimed" means the user has tokens. Keeping this as a pass is
    // deliberate; what changed is that it can no longer render as an unresolved
    // in-progress state, because the automatic claim that produced that state is
    // gone.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 429,
      json: async () => ({ error: "Already claimed — try again in 3h 12m", nextClaimAt: "2026-01-01T00:00:00Z" }),
    }));

    render(<LaunchSuccess {...props()} />);
    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/trade/${MARKET}`));
    // Asserting the navigation alone let a mutant through that set the error for
    // EVERY non-ok response and only gated `failed` — so an "already claimed"
    // 429 navigated while flashing its message as a red failure.
    expect(screen.queryByText(/Already claimed/i)).toBeNull();
  });

  it("a network error is reported, not navigated past", async () => {
    // The catch arm is code this change introduced, and nothing exercised it: no
    // test made fetch reject, so deleting `failed = true` from the catch — a
    // network error silently navigating past its own message, the exact
    // regression class this change closes — survived the whole suite.
    const f = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", f);

    render(<LaunchSuccess {...props()} />);
    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));

    await waitFor(() => expect(screen.getByText(/could not be sent/i)).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
    // Same way forward as any other failure.
    expect(screen.getByText(/Get Sim-USDC from the faucet/i)).toBeInTheDocument();
  });

  it("a double click while the claim is in flight sends one request", async () => {
    // Distinct from the retry test: that one clicks again AFTER the failure has
    // resolved. Nothing covered clicking twice while still in flight, so the
    // re-entrancy guard could be deleted — and the claim is a faucet draw, so
    // the duplicate is a wasted daily allowance, not just a wasted request.
    let release: (v: unknown) => void = () => {};
    const f = vi.fn().mockReturnValue(new Promise((r) => { release = r; }));
    vi.stubGlobal("fetch", f);

    render(<LaunchSuccess {...props()} />);
    const btn = screen.getByText(/GET SIM-USDC & TRADE/i);
    fireEvent.click(btn);
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));

    // Still mid-flight: the button is the disabled FUNDING… state.
    //
    // `disabled` is what actually stops the second click — asserted directly,
    // because the `|| mintLoading` guard inside handleMintAndTrade is redundant
    // with it and deleting that guard is therefore unobservable from here. This
    // assertion is the one that bites if the attribute goes.
    const inflight = screen.getByText(/FUNDING/i).closest("button");
    expect(inflight).toBeDisabled();
    fireEvent.click(screen.getByText(/FUNDING/i));
    expect(f).toHaveBeenCalledTimes(1);

    release({ ok: true, status: 200, json: async () => ({ amount: 500 }) });
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/trade/${MARKET}`));
  });

  it("a failed claim can be retried — the button does not stay disabled", async () => {
    // setMintLoading(true) had no matching reset. That was invisible while the
    // navigation was unconditional (the component unmounted), and became a
    // permanent "FUNDING…" on a disabled button the moment the navigation became
    // conditional — with no retry, because the plain TRADE link is the other arm
    // of the same ternary. No test clicked twice, so nothing caught it.
    const f = failingFetch();
    vi.stubGlobal("fetch", f);

    render(<LaunchSuccess {...props()} />);
    const btn = screen.getByText(/GET SIM-USDC & TRADE/i);

    fireEvent.click(btn);
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Internal server error/i)).toBeInTheDocument());

    // Still offered, and still working.
    expect(screen.getByText(/GET SIM-USDC & TRADE/i)).toBeInTheDocument();
    expect(screen.queryByText(/FUNDING/i)).toBeNull();

    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
  });

  it("keeps the actionable guidance even when the server says only 'Internal server error'", async () => {
    // GH#2608 returns exactly {"error":"Internal server error"}. Showing that
    // alone tells the creator nothing to do, so the guidance is appended rather
    // than used as a fallback that never fires.
    vi.stubGlobal("fetch", failingFetch());

    render(<LaunchSuccess {...props()} />);
    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));

    await waitFor(() => expect(screen.getByText(/Internal server error/i)).toBeInTheDocument());
    expect(screen.getByText(/faucet on the trade page/i)).toBeInTheDocument();
  });

  it("a rate-limiting 429 is a failure, not a silent success", async () => {
    // The per-IP fund limiter returns 429 with no nextClaimAt and mints nothing.
    // Counting it as success navigated the creator away with no collateral.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 429,
      json: async () => ({ error: "Too many requests. Please slow down and try again shortly." }),
    }));

    render(<LaunchSuccess {...props()} />);
    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));

    await waitFor(() => expect(screen.getByText(/Too many requests/i)).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
  });
});
