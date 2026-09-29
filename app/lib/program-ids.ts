/**
 * THE single source of truth for on-chain program IDs.
 *
 * Repointing the app to a new deployment (e.g. the P0a fresh-ID wrapper
 * `ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB` with @percolatorct/sdk 8.0.0)
 * is ONE edit: the `wrapper` value in DEVNET_PROGRAM_IDS below. Everything
 * else — config.ts (`programId`, `programsBySlabTier`, the known-program
 * allowlist), the markets static fallback, the warmup route, the NFT/stake
 * helpers, the error map's program routing — reads from here.
 * `__tests__/lib/program-ids.test.ts` fails if the SDK's own default devnet
 * wrapper id and this file disagree, so an SDK bump without the repoint (or
 * the reverse) cannot ship silently.
 *
 * Env overrides (devnet builds only; a mainnet build ignores them):
 *   NEXT_PUBLIC_WRAPPER_PROGRAM_ID, NEXT_PUBLIC_MATCHER_PROGRAM_ID,
 *   NEXT_PUBLIC_NFT_PROGRAM_ID, NEXT_PUBLIC_STAKE_PROGRAM_ID
 * For a local fork / E2E run against freshly deployed programs. Each must be a
 * valid base58 32-byte key or it is ignored (with a console warning).
 * `NEXT_PUBLIC_*` values are inlined at build time, so they are referenced
 * literally below (Next.js cannot inline a computed `process.env[name]`).
 *
 * Leaf module: no app imports (errorMessages.ts and nft-program.ts import it).
 */
import { PublicKey } from "@solana/web3.js";

export interface ProgramIdSet {
  wrapper: string;
  matcher: string;
  nft: string;
  stake: string;
}

/** Deployed devnet programs (deployments.md). The wrapper line is the repoint. */
export const DEVNET_PROGRAM_IDS: Readonly<ProgramIdSet> = Object.freeze({
  // v18.2 wrapper, fresh ID 2026-09-22. P0a relaunch: ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB
  wrapper: "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ",
  // matcher / nft / stake are upgraded in place and keep their addresses.
  matcher: "4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT",
  nft: "CNGBPZRALk9Xu8BdgWNyrLJ7daQ9eJYFf1GnEEC7YCU3",
  stake: "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3",
});

export const MAINNET_PROGRAM_IDS: Readonly<Omit<ProgramIdSet, "nft">> = Object.freeze({
  wrapper: "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv",
  matcher: "GDK8wx38kpiSVSfGTVNiSdptX3Z5R4kQyqh6Q3QX6wmi",
  stake: "DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F",
});

/** Validate a base58 program id override; null when unset or invalid. */
export function parseProgramIdOverride(name: string, raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const pk = new PublicKey(v);
    if (pk.toBase58() !== v) throw new Error("non-canonical");
    return v;
  } catch {
    console.warn(`[program-ids] ignoring invalid ${name}="${v}"`);
    return null;
  }
}

function isMainnetBuild(): boolean {
  return process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() === "mainnet";
}

/** Devnet program ids after env overrides. Pure function of build-time env. */
export function resolveDevnetProgramIds(): ProgramIdSet {
  if (isMainnetBuild()) return { ...DEVNET_PROGRAM_IDS };
  return {
    wrapper:
      parseProgramIdOverride("NEXT_PUBLIC_WRAPPER_PROGRAM_ID", process.env.NEXT_PUBLIC_WRAPPER_PROGRAM_ID) ??
      DEVNET_PROGRAM_IDS.wrapper,
    matcher:
      parseProgramIdOverride("NEXT_PUBLIC_MATCHER_PROGRAM_ID", process.env.NEXT_PUBLIC_MATCHER_PROGRAM_ID) ??
      DEVNET_PROGRAM_IDS.matcher,
    nft:
      parseProgramIdOverride("NEXT_PUBLIC_NFT_PROGRAM_ID", process.env.NEXT_PUBLIC_NFT_PROGRAM_ID) ??
      DEVNET_PROGRAM_IDS.nft,
    stake:
      parseProgramIdOverride("NEXT_PUBLIC_STAKE_PROGRAM_ID", process.env.NEXT_PUBLIC_STAKE_PROGRAM_ID) ??
      DEVNET_PROGRAM_IDS.stake,
  };
}
