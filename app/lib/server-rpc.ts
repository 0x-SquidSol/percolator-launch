import { Connection, type Commitment } from "@solana/web3.js";
import { getNetwork, getRpcEndpoint } from "./config";

/**
 * Server-side Solana Connection for API routes.
 *
 * ROOT CAUSE this fixes: server routes used `new Connection(getRpcEndpoint())`,
 * which builds the URL from `HELIUS_DEVNET_API_KEY`. That key is exhausted
 * (HTTP 429 "max usage reached"), so every server-side devnet RPC read failed —
 * surfacing to users as "Could not verify mint authority due to RPC error"
 * (faucet) and "Keeper co-sign failed (500): Failed to build co-sign tx"
 * (market-create step 2).
 *
 * The working devnet endpoint is `DEVNET_RPC_URL` — the SAME full-URL override
 * the `/api/rpc` proxy uses (route.ts). It is Origin-restricted: it returns 401
 * "Unauthorized" without the `Origin: <RPC_UPSTREAM_ORIGIN>` header
 * (default `https://trade.padre.gg`). A raw `new Connection(url)` never sends
 * that header. This helper adds it — harmless for public/unrestricted endpoints —
 * and prefers the full-URL override, mirroring `/api/rpc` exactly, then falls
 * back to `getRpcEndpoint()` / public devnet.
 *
 * SERVER-ONLY: reads `process.env.DEVNET_RPC_URL` / `RPC_UPSTREAM_ORIGIN`, which
 * are undefined in the browser. Client code must keep using the `/api/rpc` proxy.
 */
export function getServerConnection(commitment: Commitment = "confirmed"): Connection {
  const net = getNetwork();
  const override = (
    net === "mainnet" ? process.env.MAINNET_RPC_URL : process.env.DEVNET_RPC_URL
  )?.trim();
  const url = override && /^https?:\/\//.test(override) ? override : getRpcEndpoint();
  const origin =
    (process.env.RPC_UPSTREAM_ORIGIN ?? "").trim() ||
    (net === "devnet" ? "https://trade.padre.gg" : "");
  return new Connection(url, {
    commitment,
    ...(origin ? { httpHeaders: { Origin: origin } } : {}),
  });
}
