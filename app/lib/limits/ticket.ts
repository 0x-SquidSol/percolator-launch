/**
 * Order-ticket decisions for the limits UI, as ONE pure function so the
 * component only renders (plan §2, P1/P2/P3 ticket rows). Everything the
 * ticket disables, clamps or warns about comes from here and is unit-tested.
 */
import { UNLIMITED_CAPACITY } from "@/lib/marketCapacity";
import { COPY } from "./copy";
import type { MarketLimits } from "@/hooks/useMarketLimits";
import { maxTradeSizePerSide, sameOwnerBlocked, type Side, type SideLimit } from "./risk-limits";
import { preTradeQuote, quoteFailsLimit, type PreTradeQuote } from "./matcher-quote";
import { stepDownMaxLeverage } from "./vault-tranche";

export interface TicketIssue {
  kind: "halted" | "same-owner" | "step-down" | "quote-slippage" | "limits-unavailable";
  severity: "error" | "warning";
  title: string;
  message: string;
}

export interface TicketLimitsInput {
  limits: MarketLimits;
  direction: Side;
  /** |size| the ticket would submit (base q). */
  sizeQ: bigint;
  /** The taker's own signed position on the asset (0 = none). */
  takerPosQ: bigint;
  /** Connected wallet (the taker portfolio owner), or null. */
  takerOwner: Uint8Array | null;
  /** Selected leverage (x). */
  leverage: number;
  /** Worst-fill limit the ticket will sign (e6; 0 = none) — for the P2 quote check. */
  limitPriceE6: bigint;
  /** Mark used for the quote (e6). Defaults to the engine effective price. */
  markE6?: bigint;
}

export interface TicketLimits {
  sideLimits: Record<Side, SideLimit> | null;
  halted: Record<Side, boolean>;
  sameOwner: boolean;
  /** Set when the requested size exceeds the side max: clamp the input to this. */
  clampToQ: bigint | null;
  quote: PreTradeQuote | null;
  stepDown: { maxLeverage: number; stepped: boolean; baseMaxLeverage: number; crowdBps: number } | null;
  issues: TicketIssue[];
}

const NONE: TicketLimits = {
  sideLimits: null,
  halted: { long: false, short: false },
  sameOwner: false,
  clampToQ: null,
  quote: null,
  stepDown: null,
  issues: [],
};

export function deriveTicketLimits(i: TicketLimitsInput): TicketLimits {
  const L = i.limits;
  if (L.state === "off" || !L.engine) return NONE;
  const out: TicketLimits = { ...NONE, halted: { long: false, short: false }, issues: [] };
  const e = L.engine;

  // ── P1 ────────────────────────────────────────────────────────────────
  if (L.flags.p1) {
    if (L.state === "error" && !L.riskLimits) {
      out.issues.push({ kind: "limits-unavailable", severity: "warning", title: "Limits unavailable", message: COPY.limitsUnavailable });
    }
    if (L.riskLimits) {
      out.sideLimits = maxTradeSizePerSide({
        priceE6: e.effectivePriceE6,
        initialMarginBps: e.initialMarginBps,
        oiEffLongQ: e.oiEffLongQ,
        oiEffShortQ: e.oiEffShortQ,
        limits: L.riskLimits,
        lp: L.lp,
        takerPosQ: i.takerPosQ,
        matcher: L.matcher
          ? { maxFillAbs: L.matcher.maxFillAbs, maxInventoryAbs: L.matcher.maxInventoryAbs, inventoryBase: L.matcher.inventoryBase }
          : null,
      });
      out.halted = { long: out.sideLimits.long.halted, short: out.sideLimits.short.halted };
      const lim = out.sideLimits[i.direction];
      if (lim.halted) {
        out.issues.push({ kind: "halted", severity: "error", title: "Opening paused", message: COPY.halted(i.direction) });
      } else if (i.sizeQ > 0n && lim.maxQ !== UNLIMITED_CAPACITY && i.sizeQ > lim.maxQ) {
        out.clampToQ = lim.maxQ;
      }
    }
    out.sameOwner = sameOwnerBlocked(i.takerOwner, L.lp?.owner ?? null, L.assetAdmin);
    if (out.sameOwner) out.issues.push({ kind: "same-owner", severity: "error", title: "Can't trade this market from this wallet", message: COPY.sameOwner });
  }

  // ── P2 quote ─────────────────────────────────────────────────────────────
  if (L.flags.p2 && L.matcher && i.sizeQ > 0n) {
    const mark = i.markE6 ?? e.effectivePriceE6;
    const lim = out.sideLimits?.[i.direction];
    out.quote = preTradeQuote(L.matcher, mark, out.clampToQ ?? i.sizeQ, i.direction === "long", {
      bandBps: L.bandBps ?? undefined,
      headroomQ: lim && lim.maxQ !== UNLIMITED_CAPACITY ? lim.maxQ : undefined,
    });
    if (out.quote && quoteFailsLimit(out.quote.quotePriceE6, i.limitPriceE6, i.direction === "long")) {
      out.issues.push({ kind: "quote-slippage", severity: "warning", title: "Slippage limit too tight", message: COPY.quoteSlippage("your limit") });
    }
  }

  // ── P3 leverage step-down ──────────────────────────────────────────────────
  if (L.flags.p3 && L.vaultLp?.bound && L.vaultLp.levCapQ > 0n) {
    const probe = stepDownMaxLeverage(L.vaultLp.lpNetQ, 1n, i.direction === "long", L.vaultLp.levCapQ, e.initialMarginBps, L.vaultLp.levMaxImrBps);
    const atSize = i.sizeQ > 0n
      ? stepDownMaxLeverage(L.vaultLp.lpNetQ, i.sizeQ, i.direction === "long", L.vaultLp.levCapQ, e.initialMarginBps, L.vaultLp.levMaxImrBps)
      : probe;
    const base = e.initialMarginBps > 0n ? Number(10_000n / e.initialMarginBps) : 1;
    const absNet = L.vaultLp.lpNetQ < 0n ? -L.vaultLp.lpNetQ : L.vaultLp.lpNetQ;
    const crowdBps = Number((absNet * 10_000n) / L.vaultLp.levCapQ);
    out.stepDown = { maxLeverage: probe.maxLeverage, stepped: probe.stepped, baseMaxLeverage: base, crowdBps: Math.min(crowdBps, 10_000) };
    if (atSize.stepped && i.leverage > atSize.maxLeverage) {
      out.issues.push({
        kind: "step-down",
        severity: "error",
        title: "Leverage too high for this side",
        message: COPY.stepDown(String(atSize.maxLeverage), i.direction, `${(Math.min(crowdBps, 10_000) / 100).toFixed(0)}%`, String(base)),
      });
    }
  }
  return out;
}

/** base-q -> the ticket's size-input string (token units = q / 1e6, or USD at `priceE6`). */
export function sizeQToInput(q: bigint, unit: "token" | "usd", priceE6: bigint): string {
  if (unit === "token") {
    const whole = q / 1_000_000n;
    const frac = (q % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  }
  // USD atoms (6 dp) floored to cents so the clamped size never exceeds the max.
  const usdAtoms = (q * priceE6) / 1_000_000n;
  const cents = usdAtoms / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
