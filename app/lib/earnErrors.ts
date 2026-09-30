import { extractErrorCode, humanizeError } from "@/lib/errorMessages";
import { COPY } from "@/lib/limits/copy";

/**
 * User-facing copy for a failed Earn (LP vault) action.
 *
 * The generic `ERROR_CODE_MAP` copy is written for trading and is wrong or
 * silent here: the Earn panel used to show the raw `err.message`, so a vault
 * the market had locked read as an opaque "custom program error: 0x15".
 * Codes below are the deployed wrapper's (percolator-prog v18.2 `6377376a`)
 * `PercolatorError` ordinals as returned by DepositToLpVault (tag 75) and
 * ExecuteRedemption (tag 77):
 *
 *  21 EngineLockActive —
 *     deposit: the vault's backing pot is not in a state that can take new
 *       backing (`add_fresh_counterparty_backing_view`: the bucket is Fresh
 *       with a finite expiry — a realized-loss reservation the market opened
 *       — or lapsed / impaired), or the market is not Live. It clears when the
 *       keeper expires the lapsed bucket or the window ends; nothing the user
 *       can change fixes it.
 *     claim: paying the full redemption would leave the pot under-backed
 *       against traders' outstanding unrealized PnL (the stay-fully-backed
 *       `credit_rate_num == CREDIT_RATE_SCALE` gate), or the pot is not Fresh.
 *       It clears as those positions settle.
 *  19 EngineStale — the market's engine clock is behind (not cranked).
 *  36 LpVaultCooldownActive — the redemption cooldown has not elapsed.
 *  37 LpVaultOiReservationViolated — the payout would leave less than the
 *     vault's reservation threshold covering open interest.
 *  NotEnoughAccountKeys — the client sent a stale account list (a client bug,
 *     not the user's fault; see useInsuranceLP ExecuteRedemption).
 */
export type EarnAction = "deposit" | "claim";

/** What the caller knows about the vault. `p3Bound`: the vault owns its market's LP (P3). */
export interface EarnErrorContext {
  p3Bound?: boolean;
}

export function earnErrorMessage(err: unknown, action: EarnAction, ctx: EarnErrorContext = {}): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!raw) return "Transaction failed";
  if (/NotEnoughAccountKeys|insufficient account keys/i.test(raw)) {
    return "The app sent an outdated instruction layout for this vault. Please refresh the page and try again; if it persists, report it — your funds have not moved.";
  }
  const code = extractErrorCode(raw);
  switch (code) {
    case 21:
      return action === "deposit"
        ? "This market's Earn vault is temporarily locked: its backing pot can't accept new deposits right now (the market is recovering from a realized loss or its backing window has lapsed). Nothing was deposited. It clears once the market is repaired by the keeper — try again later."
        : ctx.p3Bound
          ? // E2E B24: on a P3 bound vault 21 fires with NO open positions (suspected: the
            // payout's earnings portion exceeds the pot's fee earnings, which are 0 on P3).
            // Cause unconfirmed by the P3 lane, so the copy asserts none.
            COPY.earnClaimRefusedP3
          : "Can't pay this redemption out yet: part of the vault's backing is securing traders' open unrealized PnL, and paying the full amount would leave it under-backed. It becomes claimable as those positions close. Your LP shares stay safe in escrow until then.";
    case 19:
      return "The market's engine is behind (it hasn't been cranked recently), so the vault can't be priced safely. Nothing moved. It clears once the market is cranked — try again in a moment.";
    case 36:
      return "Your redemption cooldown hasn't finished yet — claim it once the countdown reaches zero.";
    case 37:
      return action === "claim"
        ? "Claiming this much now would leave too little backing covering the market's open interest. Try a smaller redemption, or wait for open interest to fall."
        : humanizeError(raw);
    default:
      return humanizeError(raw);
  }
}
