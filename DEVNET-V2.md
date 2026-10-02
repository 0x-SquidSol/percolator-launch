# Percolator Devnet V2 — deployment addresses

Live app: **https://play.percolator.trade** (devnet v2, open to the first 1,000 on the waitlist via https://percolator.trade/playground).
Cluster: **Solana devnet**. Collateral: Sim-USDC (devnet test token, no value).

## Programs

| Program | Address |
|---|---|
| Wrapper (Percolator program) | `ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB` |
| Matcher | `EDKKgRaVHna6FCxiY1kgMzegD9rpaN1nwJNSzAzeBUBX` |
| Stake | `VmpVUArRnVkrjaPXQ2qaqCQa3ZrZFgsz7rjeALitF5w` |
| NFT | `EMYT15LZWaP7Mmmm245kQPbrTyVjG16yZiU9kfNTF3GZ` |

These are the same values as `app/lib/program-ids.ts` (`DEVNET_PROGRAM_IDS`).

## Markets (snapshot, 2026-10-02)

Every V2 market is an account **owned by the wrapper program above**. Anyone can launch a market, so this list grows — the live list is https://play.percolator.trade/markets. Older registry entries owned by previous programs (`GnwdeQr…`, `DhSkE7…`) are **not** V2.

| Market | Market (slab) account |
|---|---|
| Percolator | `9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn` |
| TRENDS | `Fz5JfUcbEdt5DNSNwZpBn2dZ7NpN8MnvJMiYjnqMacMh` |
| SI | `CeRP5hdDuLxmXQ1aNaUmrkBiYASQHumZiNzN8jpZy3CU` |
| MICRO | `AwfiVkCVpWcgjQuXh5LvGZuYo7Xn7KRjhDFxV7N7w2Ej` |
| NPC | `Fyg7RPVPybfRZeWCkRN9jHhd9NZrUqNWBRV2t7AReTFV` |
| STONK | `4EGvEGdLY2i9JeApJ8cEjkFehuSXpzfo11BBJarB7MTw` |
| PUTIN | `Ev5DZC5FGav5ZptzoAQqkn4JbYyRk3e7nXKTRznfzd6d` |
| OTC | `6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R` |
| backpack | `CzKfk54TNja7UQFyDrHfad8pKSU3QkteZhDhQwkSLDcQ` |
| Jimothy | `CzKxVxPm9gpt7eyQ3xJKh57EMT6i5bep5Swu9NRcpzCh` |

Only complete, listed markets are included (markets with an unfinished setup are left out).

## Reporting issues

Found a bug or an exploit path? Open an issue at https://github.com/dcccrypto/percolator-launch/issues (for security-sensitive findings, say so in the title and keep exploit details minimal until we follow up).
