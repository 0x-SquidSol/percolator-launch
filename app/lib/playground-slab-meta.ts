/**
 * Playground devnet slab → token metadata.
 *
 * Used in:
 *  - app/api/markets/route.ts     (discoveredToApiRow → bulk list)
 *  - app/api/markets/[slab]/route.ts  (on-chain fallback for individual slab)
 *
 * v18 markets (2026-09-22 fresh wrapper GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ):
 * all marketauth=FbTbD, each with nft_registry + stake pool + matcher + LP — every
 * one proven trade+stake. Both backing-bucket domains (asset 0) are seeded to a
 * non-lapsing expiry (u64::MAX/2 = 9223372036854775807) via TopUpBackingBucket at
 * creation. The 2026-07-10 v17 markets on the old wrapper are ABANDONED.
 */
export const PLAYGROUND_SLAB_META: Record<string, {
  symbol: string;
  name: string;
  mainnet_ca: string;
  dex_pool_address: string;
  /**
   * The market's v17 LP-portfolio account (the AMM counterparty — the
   * standalone portfolio with an enabled PortfolioMatcherConfigV16). Its
   * `capital` field is the market's real "Market LP" backing in Sim-USDC
   * atoms. Discovered once via getProgramAccounts (see lib/lp-portfolio.ts)
   * and hardcoded here so the bulk /api/markets list can read it with a
   * single cheap getMultipleAccountsInfo call instead of a per-market scan.
   * Re-discover and update if a market's LP portfolio is ever re-seeded.
   */
  lp_portfolio_address: string;
}> = {
  // SOL/USDC — raydium-clmm — v18 fresh clean re-seed 2026-09-22
  "3t2iZ8GbRiiLDGfdtFZLfSWx8v7tfWFbaEpW9Qsq22cG": {
    symbol: "SOL-PERP",
    name: "SOL/USDC Perpetual",
    mainnet_ca: "So11111111111111111111111111111111111111112",
    dex_pool_address: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
    lp_portfolio_address: "4ABxuvfnYEbKUCwgRDJpxpD4KnfKgoqUBWbz4PbpPa8T",
  },
  // JUP/USDC — meteora-dlmm — v18 fresh clean re-seed 2026-09-22
  "8JHSgJXFKdrsW8ksknQYMyrckfzkux2SkSDQZKXnSBVY": {
    symbol: "JUP-PERP",
    name: "JUP/USDC Perpetual",
    mainnet_ca: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    dex_pool_address: "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL",
    lp_portfolio_address: "9WL1c4JkYiHRP9ExLa8ewDaJhjsc9jWCiL4Geah3BUSP",
  },
  // TRUMP/USDC — meteora-dlmm — v18 fresh clean re-seed 2026-09-22
  "C8xgG7Y51pq86Avo6KGLvVbnTTEi6J1vVZxBP6xV18hL": {
    symbol: "TRUMP-PERP",
    name: "TRUMP/USDC Perpetual",
    mainnet_ca: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
    dex_pool_address: "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2",
    lp_portfolio_address: "63VuGPSf92S9fRRCxGAVbPCiRuZVWZtfp2ftnJbExtSd",
  },
  // PENGU/USDC — meteora-dlmm — v18 fresh clean re-seed 2026-09-22
  "DutyL6caGodQ486y4LBd22PHNJmKQSmP1HLPdVgeso9a": {
    symbol: "PENGU-PERP",
    name: "PENGU/USDC Perpetual",
    mainnet_ca: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
    dex_pool_address: "DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU",
    lp_portfolio_address: "78hc9cta9PiRKquJaAChkSU1pAwPJ6c2v97nuNWFKjQi",
  },
  // BURNIE/USDC — pumpswap — v18 fresh clean re-seed 2026-09-22
  "8kynWczSwQUuwu9Pcj2DgGNWuZ6UH57L4Ungx5CJUrTs": {
    symbol: "BURNIE-PERP",
    name: "BURNIE/USDC Perpetual",
    mainnet_ca: "CGEDT9QZDvvH5GmVkWJH2BXiMJqMJySC9ihWyr7Spump",
    dex_pool_address: "5tYFviFWQRKV9BJSTHGitbdqEYC1BGUgRUDnSADUXqJP",
    lp_portfolio_address: "AWN49Fq5ZaL2amEwtTTu6Fx7AWDv2xLKKQq5mRePhSrb",
  },
  // Percolator/USDC — pumpswap — v18 fresh clean re-seed 2026-09-22
  "7iP6v2Am2yHBJy9ymWRdf6hEhYccuBMEXSJj7x5CAPDP": {
    symbol: "PERCOLATOR-PERP",
    name: "Percolator/USDC Perpetual",
    mainnet_ca: "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump",
    dex_pool_address: "Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW",
    lp_portfolio_address: "E8Qqrkj4tbr9PAB5jqKGDkjPdnWUYsYGNN7xUe7c2YM6",
  },
};
