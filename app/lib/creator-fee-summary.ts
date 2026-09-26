/**
 * Creator fee-claim roll-up for the /my-markets dashboard.
 *
 * A creator owning N markets needs three questions answered before they will
 * trust a claim button: how much has each market accrued, how much is there in
 * total, and which markets could not be read. The dashboard previously answered
 * none of them — the claim UI was one panel per market, buried inside each
 * row's expand drawer, with no totals anywhere.
 *
 * THE THREE-STATE RULE
 *
 * `creator_fee_claimable_atoms` has three meanings and they must not be
 * collapsed into a number:
 *
 *   - a value > 0        → claimable, show it
 *   - a value of exactly 0 → read fine, genuinely nothing accrued yet
 *   - ABSENT or unparseable → UNKNOWN, and must never render as "$0.00"
 *
 * The third case is not hypothetical. `/api/markets/[slab]`'s Supabase branch
 * returned no creator-fee fields at all (verified against the playground: every
 * market answered 200 with the key absent), and the row read
 * `detail?.creator_fee_claimable_atoms ? … : 0n` — so "we could not read this"
 * rendered as "you have earned nothing", on every market, for every creator.
 * Telling a creator they have no fees when they do is the worst failure this
 * module can have, so `unknown` is a first-class state here.
 *
 * WHY TOTALS ARE PER COLLATERAL MINT
 *
 * Atoms are only comparable within one mint: summing them across markets with
 * different collateral tokens or different decimals produces a number that
 * means nothing, which is the same mistake the aggregate-OI roll-up documents
 * (a quantity of one asset cannot be added to a quantity of another). Every
 * playground market happens to collateralize in sim-USDC, but nothing enforces
 * that, so the roll-up groups by mint and reports one total per mint rather
 * than one grand total that silently assumes they are interchangeable.
 */

/** What we know about one market's claimable creator fees. */
export type ClaimableState =
  | { kind: "claimable"; atoms: bigint }
  | { kind: "none" }
  | { kind: "unknown" };

/**
 * Classify the raw `creator_fee_claimable_atoms` field from the API.
 *
 * It arrives as a STRING because a u64 exceeds `Number.MAX_SAFE_INTEGER` long
 * before it becomes an implausible balance — so it is never narrowed to
 * `number` here. `null`/`undefined` (field absent, or the on-chain read failed)
 * and anything unparseable are `unknown`, never zero.
 */
export function classifyClaimable(raw: string | null | undefined): ClaimableState {
  if (raw == null) return { kind: "unknown" };
  const text = String(raw).trim();
  if (text === "") return { kind: "unknown" };
  let atoms: bigint;
  try {
    atoms = BigInt(text);
  } catch {
    return { kind: "unknown" };
  }
  // A negative counter is not a small balance — it is a bad read.
  if (atoms < 0n) return { kind: "unknown" };
  if (atoms === 0n) return { kind: "none" };
  return { kind: "claimable", atoms };
}

/** One market's contribution to the roll-up. */
export interface CreatorFeeEntry {
  slab: string;
  claimable: ClaimableState;
  /** Collateral mint this market's fees are denominated in. Null = unknown, which
   *  keeps it out of every total rather than defaulting it into one. */
  collateralMint: string | null;
  decimals: number;
  /** True when the connected wallet is asset 0's `asset_admin` — the only wallet
   *  tag 90 accepts. A balance the connected wallet cannot claim still counts
   *  toward "earned", never toward "claim all". */
  isClaimAuthority: boolean;
}

/** Total for one collateral mint, in display units. */
export interface MintTotal {
  collateralMint: string;
  decimals: number;
  /** Sum over markets with a KNOWN balance, in display units (atoms / 10^dp). */
  total: number;
  /** Subtotal the connected wallet can actually claim right now. */
  claimableByWallet: number;
  /** Markets contributing a positive balance. */
  markets: number;
}

export interface CreatorFeeSummary {
  /** One entry per collateral mint, so nothing is added across incomparable units. */
  totalsByMint: MintTotal[];
  /** Markets with a positive, known balance. */
  marketsWithFees: number;
  /** Markets whose balance could not be read. Drives the "N unknown" caveat. */
  unknownMarkets: number;
  /** Markets read successfully (positive or zero). */
  knownMarkets: number;
  /** Markets the connected wallet can claim from right now. */
  claimableMarkets: number;
  /** True when NOTHING could be read — the totals are not a zero, they are absent. */
  allUnknown: boolean;
}

/**
 * Roll up per-market claimable balances.
 *
 * Markets with an `unknown` balance contribute to `unknownMarkets` and to
 * NOTHING else: they are deliberately excluded from every total, because
 * folding an unreadable market in as 0 is exactly the conflation this module
 * exists to prevent.
 */
export function summarizeCreatorFees(entries: readonly CreatorFeeEntry[]): CreatorFeeSummary {
  const byMint = new Map<string, MintTotal>();
  let marketsWithFees = 0;
  let unknownMarkets = 0;
  let knownMarkets = 0;
  let claimableMarkets = 0;

  for (const entry of entries) {
    if (entry.claimable.kind === "unknown") {
      unknownMarkets += 1;
      continue;
    }
    knownMarkets += 1;
    if (entry.claimable.kind === "none") continue;

    marketsWithFees += 1;
    // A known balance in an unknown denomination cannot join a total, but it is
    // still a market with fees — counted above, omitted here.
    if (entry.collateralMint == null) continue;

    const units = Number(entry.claimable.atoms) / 10 ** entry.decimals;
    const existing = byMint.get(entry.collateralMint);
    const bucket: MintTotal = existing ?? {
      collateralMint: entry.collateralMint,
      decimals: entry.decimals,
      total: 0,
      claimableByWallet: 0,
      markets: 0,
    };
    bucket.total += units;
    bucket.markets += 1;
    if (entry.isClaimAuthority) {
      bucket.claimableByWallet += units;
      claimableMarkets += 1;
    }
    byMint.set(entry.collateralMint, bucket);
  }

  return {
    totalsByMint: [...byMint.values()],
    marketsWithFees,
    unknownMarkets,
    knownMarkets,
    claimableMarkets,
    allUnknown: entries.length > 0 && knownMarkets === 0,
  };
}

/** The slabs a "claim all" should submit, in a stable order. */
export function claimAllTargets(entries: readonly CreatorFeeEntry[]): string[] {
  return entries
    .filter((e) => e.claimable.kind === "claimable" && e.isClaimAuthority)
    .map((e) => e.slab);
}
