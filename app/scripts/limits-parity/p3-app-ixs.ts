/**
 * Emits APP-BUILT P3 instructions as JSON for the LiteSVM scenario
 * `limits_app_p3_end_to_end` (patch: scripts/limits-parity/p3-sim/). The instructions come
 * from the SAME lib code the hooks send:
 *   bind      -> lib/limits/p3-wizard.ts buildP3BindIxs            (wizard M4p / step 5)
 *   deposit   -> lib/limits/earn-ixs.ts earnTxPlan + buildEarnDepositIxs  (useInsuranceLP.deposit)
 *   execute   -> lib/limits/earn-ixs.ts earnTxPlan + buildEarnExecuteIxs  (useInsuranceLP.withdraw)
 *   exit      -> lib/limits/resolved-exit-ixs.ts exitStepIxs      (useResolvedExit)
 *   junior-release -> lib/limits/junior-resolved-release.ts (useJuniorTranche.releaseResolved):
 *                ATA-idempotent + [78 if pending] + 102 resolved, amount = physical - C from raw bytes
 *   init-market -> lib/create-market-args.ts slabSizeFor + buildV17InitMarketArgs (create() M1:
 *                createAccount(slab) + InitMarket [admin, slab, mint]); p3 => 1 slot, else 14
 *   plan      -> lib/limits/resolved-exit.ts planResolvedExit on RAW account bytes (base64),
 *                decoded by lib/limits/decode.ts exactly as the hook does
 * argv: <cmd> <json>. Keys are base58; bigints are decimal strings.
 */
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { ACCOUNTS_INIT_MARKET, buildAccountMetas, buildIx, deriveLpBackingLedger, encodeInitMarket } from "@percolatorct/sdk";
import { buildV17InitMarketArgs, marketAssetSlotsFor, slabSizeFor } from "../../lib/create-market-args";
import { deriveMarketParams, MIN_LEVERAGE_X } from "../../lib/market-params";
import { buildP3BindIxs, canonicalVaultLpMatcher } from "../../lib/limits/p3-wizard";
import { buildEarnDepositIxs, buildEarnExecuteIxs, earnTxPlan } from "../../lib/limits/earn-ixs";
import { CANONICAL_VAULT_LP_MATCHER_PROGRAM_DEVNET, TAG_DEPOSIT_TO_LP_VAULT, TAG_EXECUTE_REDEMPTION, KIND_PORTFOLIO } from "../../lib/limits/constants";
import { buildDepositJuniorTrancheIx, buildWithdrawJuniorTrancheIx, deriveLpVaultRegistryPda, deriveVaultLpState } from "../../lib/limits/p3-ix";
import { exitStepIxs, type ExitPortfolioRef } from "../../lib/limits/resolved-exit-ixs";
import { planResolvedExit, type ExitStep, type ExitPortfolio } from "../../lib/limits/resolved-exit";
import {
  decodeLpVaultRegistryBound,
  decodeLpVaultRegistryShares,
  decodeMarketEngineView,
  decodeResolvedMarket,
  decodeLpVaultRegistryDomain,
  decodeResolvedPortfolio,
  decodeTerminalBacking,
  decodeVaultLpState,
  decodePortfolioRisk,
} from "../../lib/limits/decode";
import { earnAbsorbed, harvestableFeeAtoms, vaultLpValueAtoms } from "../../lib/limits/vault-tranche";
import { find77, recallCandidates, withRecallBefore77 } from "../../lib/limits/senior-draw-repair";
import { parseP3DrawLogs, summarizeDrawEvents } from "../../lib/limits/p3-draw-logs";
import { planOwnPortfolioCleanup } from "../../lib/limits/own-portfolio-cleanup";
import { buildJuniorResolvedReleaseIxs, juniorReleaseNeedsHarvest, juniorResolvedReleasableAtoms } from "../../lib/limits/junior-resolved-release";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

interface J { [k: string]: unknown }
const [cmd, raw] = process.argv.slice(2);
const a = JSON.parse(raw ?? "{}") as J;
const pk = (k: string): PublicKey => new PublicKey(String(a[k]));
const big = (k: string): bigint => BigInt(String(a[k]));
const b64 = (s: unknown): Uint8Array => new Uint8Array(Buffer.from(String(s), "base64"));

function enc1(ix: TransactionInstruction) {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    dataHex: Buffer.from(ix.data).toString("hex"),
  };
}

function out(ixs: TransactionInstruction[], extra: J = {}): void {
  process.stdout.write(
    JSON.stringify({
      ...extra,
      ixs: ixs.map((ix) => ({
        programId: ix.programId.toBase58(),
        keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
        dataHex: Buffer.from(ix.data).toString("hex"),
      })),
    }),
  );
}

/** The P3 Earn context from raw account bytes (what readEarnP3Context decodes after its RPC). */
function earnCtx(programId: PublicKey, market: PublicKey) {
  const md = b64(a.marketB64);
  const rd = b64(a.registryB64);
  const sd = a.vaultLpStateB64 ? b64(a.vaultLpStateB64) : null;
  const view = decodeMarketEngineView(md);
  const st = sd ? decodeVaultLpState(sd) : null;
  const rm = decodeResolvedMarket(md);
  const dom = decodeLpVaultRegistryDomain(rd);
  const tb = dom !== null ? decodeTerminalBacking(md, dom) : null;
  return {
    terminalFlat: !!rm && rm.mode === 1 && rm.materializedPortfolioCount === 0n && rm.cTot === 0n,
    terminalResidual: tb ? tb.residual : null,
    bound: decodeLpVaultRegistryBound(rd),
    vaultLpState: deriveVaultLpState(programId, market),
    lpPortfolio: st ? new PublicKey(st.lpPortfolio) : null,
    harvestable: view ? harvestableFeeAtoms(view) : null,
    registryShares: decodeLpVaultRegistryShares(rd),
    mode: view ? view.mode : 0,
  };
}

const programId = pk("programId");
const market = pk("market");
const domain = Number(a.domain ?? 0);
const ledger = deriveLpBackingLedger(programId, market, domain)[0];
const siblingLedger = deriveLpBackingLedger(programId, market, domain ^ 1)[0];
const registry = deriveLpVaultRegistryPda(programId, market);

if (cmd === "init-market") {
  // Exactly create()'s M1 shape: the slab sized by slabSizeFor(params), InitMarket args from
  // buildV17InitMarketArgs(params, derived) with derived = deriveMarketParams(leverage, lp, price).
  const params = {
    p3: a.p3 === true ? { juniorFloorBps: 1_000, juniorAtoms: big("lpCollateral") } : undefined,
    initialPriceE6: big("initialPriceE6"),
    tradingFeeBps: Number(a.tradingFeeBps),
    initialMarginBps: Number(a.initialMarginBps),
    lpCollateral: big("lpCollateral"),
  };
  const derived = deriveMarketParams(
    params.initialMarginBps > 0 ? 10_000 / params.initialMarginBps : MIN_LEVERAGE_X,
    params.lpCollateral,
    params.initialPriceE6,
  );
  const space = slabSizeFor(params);
  out(
    [
      SystemProgram.createAccount({
        fromPubkey: pk("funder"), newAccountPubkey: market, lamports: Number(a.lamports), space, programId,
      }),
      buildIx({
        programId,
        keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, { admin: pk("admin"), slab: market, mint: pk("mint") }),
        data: encodeInitMarket(buildV17InitMarketArgs(params, derived)),
      }),
    ],
    { space, maxPortfolioAssets: marketAssetSlotsFor(params) },
  );
} else if (cmd === "junior-release") {
  const md = b64(a.marketB64);
  const st = decodeVaultLpState(b64(a.vaultLpStateB64));
  if (!st) throw new Error("no vault LP state");
  const owner = pk("owner");
  const mint = pk("mint");
  const releasable = juniorResolvedReleasableAtoms(md, domain, st.seniorClaimAtoms);
  if (releasable === null) throw new Error("terminal backing unreadable");
  // `amount` overrides the planned amount (negative controls only; the UI caps at releasable).
  const amount = a.amount !== undefined ? big("amount") : releasable;
  const needHarvest = juniorReleaseNeedsHarvest(md, domain);
  const vm = { programId, market, registry, vaultLpState: deriveVaultLpState(programId, market), lpPortfolio: new PublicKey(st.lpPortfolio), ledger, siblingLedger };
  const ownerAta = getAssociatedTokenAddressSync(mint, owner);
  out(
    amount > 0n
      ? buildJuniorResolvedReleaseIxs({ vm, domain, owner, ownerAta, mint, vaultToken: pk("vaultToken"), vaultAuthority: pk("vaultAuthority") }, amount, needHarvest)
      : [],
    { amount: amount.toString(), releasable: releasable.toString(), needHarvest, ownerAta: ownerAta.toBase58() },
  );
} else if (cmd === "bind") {
  out(
    buildP3BindIxs({
      market: { programId, market, registry, vaultLpState: deriveVaultLpState(programId, market), lpPortfolio: pk("vaultLpPortfolio"), ledger, siblingLedger },
      creator: pk("creator"),
      vaultLpPortfolio: pk("vaultLpPortfolio"),
      portfolioLen: Number(a.portfolioLen),
      portfolioRentLamports: Number(a.rent),
      matcherProgram: canonicalVaultLpMatcher(String(a.matcherProgram ?? CANONICAL_VAULT_LP_MATCHER_PROGRAM_DEVNET)),
      matcherCtx: pk("matcherCtx"),
      matcherCtxRentLamports: Number(a.ctxRent),
      juniorFloorBps: Number(a.floorBps),
      juniorAtoms: big("juniorAtoms"),
      creatorAta: pk("creatorAta"),
      vaultToken: pk("vaultToken"),
    }),
  );
} else if (cmd === "deposit" || cmd === "execute") {
  const ctx = earnCtx(programId, market);
  const plan = earnTxPlan(cmd === "deposit" ? TAG_DEPOSIT_TO_LP_VAULT : TAG_EXECUTE_REDEMPTION, ctx);
  if (!plan.ok) {
    out([], { blocked: plan.reason });
  } else if (cmd === "deposit") {
    out(
      buildEarnDepositIxs({
        programId, depositor: pk("user"), market, registry, lpMint: pk("lpMint"), depositorLpAta: pk("lpAta"),
        sourceToken: pk("source"), vaultToken: pk("vaultToken"), ledger, siblingLedger, domain, amount: big("amount"), plan,
      }),
      { prependHarvest: plan.prependHarvest, tail: !!plan.tail },
    );
  } else {
    out(
      buildEarnExecuteIxs({
        programId, redeemer: pk("user"), market, registry, redemption: pk("redemption"), lpMint: pk("lpMint"), escrow: pk("escrow"),
        vaultToken: pk("vaultToken"), vaultAuthority: pk("vaultAuthority"), ledger, redeemerDest: pk("dest"), siblingLedger, domain, plan,
      }),
      { prependHarvest: plan.prependHarvest, tail: !!plan.tail },
    );
  }
} else if (cmd === "recall-variants") {
  // The 88 repair (lib/limits/senior-draw-repair.ts, run by sendTx): the SAME execute list the
  // Earn claim sends, and for each recall candidate the list with a 98 inserted before the 77.
  // sendTx simulates them in order and keeps the first that succeeds; the sim does the same.
  const ctx = earnCtx(programId, market);
  const plan = earnTxPlan(TAG_EXECUTE_REDEMPTION, ctx);
  if (!plan.ok) throw new Error(`blocked: ${plan.reason}`);
  const exec = buildEarnExecuteIxs({
    programId, redeemer: pk("user"), market, registry, redemption: pk("redemption"), lpMint: pk("lpMint"), escrow: pk("escrow"),
    vaultToken: pk("vaultToken"), vaultAuthority: pk("vaultAuthority"), ledger, redeemerDest: pk("dest"), siblingLedger, domain, plan,
  });
  const md = b64(a.marketB64);
  const vs = decodeVaultLpState(b64(a.vaultLpStateB64));
  if (!vs) throw new Error("no vault LP state");
  const eng = decodeMarketEngineView(md);
  const risk = a.lpB64 ? decodePortfolioRisk(b64(a.lpB64)) : null;
  const lpVal = eng && risk ? vaultLpValueAtoms(risk, eng) : null;
  const at = find77(exec, programId);
  const cands = recallCandidates(md, vs, domain, lpVal && lpVal.kind !== "stale" ? lpVal.atoms : null);
  process.stdout.write(
    JSON.stringify({
      candidates: cands.map(String),
      plain: exec.map(enc1),
      variants: cands.map((amount) => ({ amount: amount.toString(), ixs: withRecallBefore77(exec, at, pk("user"), amount).map(enc1) })),
    }),
  );
} else if (cmd === "draw-logs") {
  const ev = parseP3DrawLogs(a.logs as string[]);
  process.stdout.write(JSON.stringify({ events: JSON.parse(JSON.stringify(ev, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), summary: JSON.parse(JSON.stringify(summarizeDrawEvents(ev), (_k, v) => (typeof v === "bigint" ? v.toString() : v))) }));
} else if (cmd === "earn-absorbed") {
  const vs = decodeVaultLpState(b64(a.vaultLpStateB64));
  const r = vs ? earnAbsorbed(vs) : null;
  process.stdout.write(JSON.stringify(r ? { outstanding: r.outstanding.toString(), drawn: r.drawn.toString(), restored: r.restored.toString() } : null));
} else if (cmd === "junior-withdraw" || cmd === "junior-deposit") {
  // useJuniorTranche: 97 / 96 against the vault LP named by the on-chain vault-LP state.
  const st = decodeVaultLpState(b64(a.vaultLpStateB64));
  if (!st) throw new Error("vault LP state not decodable");
  const vm = { programId, market, registry, vaultLpState: deriveVaultLpState(programId, market), lpPortfolio: new PublicKey(st.lpPortfolio), ledger, siblingLedger };
  out([
    cmd === "junior-withdraw"
      ? buildWithdrawJuniorTrancheIx(vm, pk("owner"), pk("dest"), pk("vaultToken"), pk("vaultAuthority"), big("amount"))
      : buildDepositJuniorTrancheIx(vm, pk("owner"), pk("source"), pk("vaultToken"), big("amount")),
  ]);
} else if (cmd === "own-cleanup") {
  // useCloseMarket (B12): the wallet's OWN portfolios on a Resolved market, owner-signed groups.
  const portfolios = ((a.portfolios as J[]) ?? []).flatMap((p) => {
    const view = decodeResolvedPortfolio(b64(p.dataB64));
    return view ? [{ key: new PublicKey(String(p.key)), view, portfolioId: BigInt(String(p.portfolioId)), matcherSequence: BigInt(String(p.matcherSequence)), positionEpoch: BigInt(String(p.positionEpoch)) }] : [];
  });
  const groups = planOwnPortfolioCleanup({ programId, owner: pk("owner"), market, collateralMint: pk("mint"), vaultToken: pk("vaultToken"), vaultAuthority: pk("vaultAuthority"), portfolios });
  const g = groups[0];
  if (!g) {
    out([], { groups: 0 });
  } else {
    // two ix lists: [withClose, withoutClose]; the harness applies runOwnPortfolioCleanup's rule
    process.stdout.write(JSON.stringify({ kind: g.kind, withClose: JSON.parse(JSON.stringify(g.withClose.map(enc1))), withoutClose: g.withoutClose ? g.withoutClose.map(enc1) : null }));
  }
} else if (cmd === "plan" || cmd === "exit") {
  // Decode every account exactly as useResolvedExit does, plan, and (exit) build the first step.
  const md = b64(a.marketB64);
  const rd = b64(a.registryB64);
  const sd = a.vaultLpStateB64 ? b64(a.vaultLpStateB64) : null;
  const m = decodeResolvedMarket(md);
  if (!m) throw new Error("market not decodable");
  const bound = decodeLpVaultRegistryBound(rd) === true;
  const st = bound && sd ? decodeVaultLpState(sd) : null;
  const vaultLpKey = st ? new PublicKey(st.lpPortfolio).toBase58() : null;
  const portfolios: ExitPortfolio[] = [];
  const refs = new Map<string, ExitPortfolioRef>();
  for (const p of (a.portfolios as J[]) ?? []) {
    const d = b64(p.dataB64);
    if (d[10] !== KIND_PORTFOLIO) continue;
    const view = decodeResolvedPortfolio(d);
    if (!view) continue;
    const key = String(p.key);
    const owner = new PublicKey(view.owner);
    refs.set(key, { owner, portfolioId: BigInt(String(p.portfolioId)), matcherSequence: BigInt(String(p.matcherSequence)), positionEpoch: BigInt(String(p.positionEpoch)) });
    const isVaultLp = key === vaultLpKey;
    portfolios.push({ key, view, isVaultLp, escrowed: !isVaultLp && !PublicKey.isOnCurve(owner.toBytes()) && !owner.equals(registry) });
  }
  const engine = decodeMarketEngineView(md);
  const plan = planResolvedExit({
    market: m, nowSlot: big("nowSlot"), portfolios, boundVault: bound, harvestableAtoms: engine ? harvestableFeeAtoms(engine) : null,
    terminalResidualAtoms: decodeTerminalBacking(md, domain)?.residual ?? null,
  });
  const steps: ExitStep[] = plan.phase === "sweep" || plan.phase === "owner-window" ? plan.steps : [];
  const blockers = plan.phase === "not-resolved" ? [] : plan.blockers.map((b) => b.kind);
  const summary: J = { phase: plan.phase, steps: steps.map((s) => ({ kind: s.kind, portfolio: "portfolio" in s ? s.portfolio : "" })), blockers };
  if (cmd === "plan" || steps.length === 0) {
    out([], summary);
  } else {
    const vaultAuthority = pk("vaultAuthority");
    const ctx = {
      payer: pk("payer"),
      collateralMint: pk("mint"),
      vaultToken: pk("vaultToken"),
      vaultAuthority,
      programId,
      market,
      portfolios: refs,
      vault: st
        ? { programId, market, registry, vaultLpState: deriveVaultLpState(programId, market), lpPortfolio: new PublicKey(st.lpPortfolio), ledger, siblingLedger, juniorOwner: new PublicKey(st.juniorOwner), domain }
        : null,
    };
    const first = steps[0];
    if (!first) throw new Error("no step");
    out(exitStepIxs(first, ctx), summary);
  }
} else {
  throw new Error(`unknown cmd ${cmd}`);
}
