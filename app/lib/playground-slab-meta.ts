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
  // SOL/USDC — raydium-clmm — v18 2026-09-22
  "BxSzmN1ZjmjwLgZyX7djctDa4bsr1wH82Ms8BWfeRaZ1": {
    symbol: "SOL-PERP",
    name: "SOL/USDC Perpetual",
    mainnet_ca: "So11111111111111111111111111111111111111112",
    dex_pool_address: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
    lp_portfolio_address: "H33XTYC4WKSpSspA4gVaRPjeLMYf9qKQgFf5ueYxcyRW",
  },
  // JUP/USDC — meteora-dlmm — v18 2026-09-22
  "3idZvebuXmaMCcwXZET6AFHhQYpdC77z2XGM9fyfzCTp": {
    symbol: "JUP-PERP",
    name: "JUP/USDC Perpetual",
    mainnet_ca: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    dex_pool_address: "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL",
    lp_portfolio_address: "Ho3j17hybJiwhGSneAaN4GD7LRr6Uugwn4PL8jK2em95",
  },
  // PENGU/USDC — meteora-dlmm — v18 2026-09-22
  "4dcgGXtXQo25Jzkc64d7aUFSmrz298nJorm7PnfTUs7p": {
    symbol: "PENGU-PERP",
    name: "PENGU/USDC Perpetual",
    mainnet_ca: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
    dex_pool_address: "DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU",
    lp_portfolio_address: "7JBxotpPVCUgGeLRgF5fcXeUMQu5QyaNpMHNw32gA6Z6",
  },
  // BURNIE/USDC — pumpswap — v18 2026-09-22
  "D1bHqCaoAFtgXfyJmwi726dJyubZ4Uu51b8DDEhcV4bh": {
    symbol: "BURNIE-PERP",
    name: "BURNIE/USDC Perpetual",
    mainnet_ca: "CGEDT9QZDvvH5GmVkWJH2BXiMJqMJySC9ihWyr7Spump",
    dex_pool_address: "5tYFviFWQRKV9BJSTHGitbdqEYC1BGUgRUDnSADUXqJP",
    lp_portfolio_address: "4dtoJQwhLzdnmx4ZwJrzaJr4fSu3yj9GuFVbvaduNsFM",
  },
  // Percolator/USDC — pumpswap — v18 2026-09-22
  "7zZKbmQv1CKcvZz9B6PnTEBfzVz2r1zroUJGEsGwCmev": {
    symbol: "PERCOLATOR-PERP",
    name: "Percolator/USDC Perpetual",
    mainnet_ca: "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump",
    dex_pool_address: "Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW",
    lp_portfolio_address: "HGdqorMTaCmgpjWmF5bDmoYTvd7TjZQBmJEtnmBxHaiE",
  },
};
