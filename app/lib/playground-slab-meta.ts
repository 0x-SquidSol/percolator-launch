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
  "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr": {
    symbol: "SOL-PERP",
    name: "SOL/USDC Perpetual",
    mainnet_ca: "So11111111111111111111111111111111111111112",
    dex_pool_address: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
    lp_portfolio_address: "3oDTvjEP9AW6XQVSE6VTJPY7Bre96jeBVfjJ3cXcrX5w",
  },
  // JUP/USDC — meteora-dlmm — v18 fresh clean re-seed 2026-09-22
  "HvCDVSx5gStg1WAxBAaXwpouLyTvAHCyBPHJHh3RfVJg": {
    symbol: "JUP-PERP",
    name: "JUP/USDC Perpetual",
    mainnet_ca: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    dex_pool_address: "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL",
    lp_portfolio_address: "JC8w1bKSJSxi2g5Qy7tGvoLku7eyRpGWhgQd4EVXDoEK",
  },
  // TRUMP/USDC — meteora-dlmm — v18 fresh clean re-seed 2026-09-22
  "CdN8r7FBYBvCGAS75TKAK5UCzY9Zv9P4HaGHuTJ3VXNg": {
    symbol: "TRUMP-PERP",
    name: "TRUMP/USDC Perpetual",
    mainnet_ca: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
    dex_pool_address: "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2",
    lp_portfolio_address: "7tqhPH4UDyD11tq4vBSsJXxRYHpgbffEDE218Fbk9o5K",
  },
  // PENGU/USDC — meteora-dlmm — v18 fresh clean re-seed 2026-09-22
  "ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ": {
    symbol: "PENGU-PERP",
    name: "PENGU/USDC Perpetual",
    mainnet_ca: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
    dex_pool_address: "DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU",
    lp_portfolio_address: "GvVHZuav4uvn6MsMNgShS8oHR1Rhpb6N3SQqSF1cjzkE",
  },
  // BURNIE/USDC — pumpswap — v18 fresh clean re-seed 2026-09-22
  "BeumQKPdWHTBewYnbGDbcUed5EPvr39covYtPPqJkYGV": {
    symbol: "BURNIE-PERP",
    name: "BURNIE/USDC Perpetual",
    mainnet_ca: "CGEDT9QZDvvH5GmVkWJH2BXiMJqMJySC9ihWyr7Spump",
    dex_pool_address: "5tYFviFWQRKV9BJSTHGitbdqEYC1BGUgRUDnSADUXqJP",
    lp_portfolio_address: "AbHufbvPL4TCVd6d86SKfGAtCS2687QzR3HhG67vxKzc",
  },
  // Percolator/USDC — pumpswap — v18 fresh clean re-seed 2026-09-22
  "BbuB3mb5DkFmJLfoaumkbM6eEv3wZDjz9YZokhEgVJv3": {
    symbol: "PERCOLATOR-PERP",
    name: "Percolator/USDC Perpetual",
    mainnet_ca: "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump",
    dex_pool_address: "Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW",
    lp_portfolio_address: "CtMKqDFDa3pxMHEQ5iZ6caAdeZtrEfWCJEHFNDMUPDsg",
  },
};
