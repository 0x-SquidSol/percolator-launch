# P3 sim: the vault-owned-LP journey executing APP-BUILT instructions

## 58e379f1 (P3 FINAL, 2026-09-30): current run

Patch now over `feat/p3-vault-owned-lp@58e379f1` (engine `35ddd692` unchanged). Added on top of
the tests below (all APP-BUILT through `p3-app-ixs.ts`):

| test | what it proves (real wrapper + matcher BPF, LiteSVM) |
|---|---|
| `limits_app_p3_single_asset_market_binds_and_trades` | the market is created by the APP's M1 (`init-market`: `createAccount(slab, slabSizeFor)` + InitMarket from `buildV17InitMarketArgs`), 1 slot, 3675 B = `market_account_len_for_capacity(1)`; the app bind (94 auto-pin + 96) lands and a trade follows; conservation holds |
| `limits_app_legacy_14_slot_market_is_refused_by_94_negative_control` | same, with the LEGACY args (14 slots, 33900 B): tag 94 refuses `VaultLpMultiAssetMarket` (86), no vault-LP state |
| `limits_app_p3_f14_terminal_order_101_78_77_102` | F-14 order: sweep `settle-vault-lp` (101 moves no SPL, asserted) -> close-empty -> close-resolved -> close-empty -> `harvest` (78) -> ready; both seniors' app 77 pay >= principal (5,033,600 / 10,066,193), C left = 1,007 (dead-share dust); the junior's app 102 Resolved (`junior-release`, `lib/limits/junior-resolved-release.ts`) pays exactly `physical - C` = 60,000,000; one atom more is refused 83; afterwards the app plans nothing; conservation holds |

Results, 8/8 `limits_` and 50/50 for the whole `p3_vault_lp` (with `P2_MATCHER_SO`), on BOTH builds:
- mine: `cargo build-sbf --features devnet` in this worktree, sha256 `731138c1b26a34ecb6cb002973d4a98983c01f79e363ca2bb1c74aa17aa51406`;
- RELAUNCH (P3 lane, `~/wt-p3-wrapper/percolator-prog`, src identical to 58e379f1): `f1a1dfc3ff7e86ffea53394295c8e587f3309e9bda6dd3d9ce6bfcc68e07b21e`, copied into `target/deploy/` for the run and restored.

App-side negative controls on real BPF: `P3_MARKET_ASSET_SLOTS = 14` -> the single-asset test fails
(app slot count 14); `juniorResolvedReleasableAtoms` returning `physical` (ignoring C) -> 102 refused
`Custom(83)`. Each restored byte-identical and green after.

The sections below are the earlier heads' record (kept as-is).

Patch over `dcccrypto/percolator-prog` `feat/p3-vault-owned-lp@07a1d0eb` — the FINAL combined head
(P1 `3acb34ae`; tag 94 marketauth-only with AUTO-PIN; 78 on terminal-flat Resolved; C-4(b)) — with engine `35ddd692` as the
sibling `../percolator` and the matcher `.so` from `percolator-match@12bd671` at
`../percolator-match/target/deploy/`. Earlier runs on `424fe7e4` and `ee29b5ac` gave identical
results up to the auto-pin change (the bind and the resolved harvest are the 07a1d0eb deltas). It appends to `tests/p3_vault_lp.rs`:

| test | what it proves (real wrapper + matcher BPF, LiteSVM) |
|---|---|
| `limits_app_p3_end_to_end` | (07a1d0eb) the wizard bind is `createAccount(LP) + createAccount(ctx, owner = canonical matcher) + 94 (11 accounts, auto-pin) + 96` and a trade lands IMMEDIATELY after it (no protocol 99/95); the vault-LP bytes are dumped for `__tests__/hooks/useTrade.vault-lp-autopin.test.ts`. Every app-sent instruction comes from `app/scripts/limits-parity/p3-app-ixs.ts`, i.e. the SAME lib code the hooks call: wizard M4p (`buildP3BindIxs`: createAccount + 94 path A + 96); bound Earn deposit (`earnTxPlan` + `buildEarnDepositIxs`, tail [11]/[12]); live redemption with the P3-K1 harvest (`buildEarnExecuteIxs`: 78 + 77, tail [13]/[14]); the whole resolved sweep planned from RAW account bytes (`planResolvedExit` + `exitStepIxs`: 101 -> 8(owner = registry) -> 30 permissionless -> 8 -> ready) and the resolved redemption. Negative controls in-test: the deposit with its tail stripped is refused; 77 without the prepended 78 fails `VaultLpHarvestPending` (84). Conservation (`assert_conserved`) holds. |
| `limits_app_p3_own_cleanup_before_reclaim` | E2E B12 app side: the trader's OWN portfolio on a Resolved market via the app's owner-signed group (`planOwnPortfolioCleanup`, bridge `own-cleanup`): 30 + 8 in ONE tx, `materialized_portfolio_count` 2 -> 1, payout 19,700,000 to the owner's ATA, conservation holds |
| `limits_app_p3_resolved_harvest_then_redeem` | fees unharvested at resolution: the APP's sweep ends `sweep:harvest` (78 once terminal-flat) and the APP's redemption pays 10,142,985 (= the harvest-while-live control) |
| `limits_ui_repro_resolved_redemption_with_pending_fees` | the program finding (FAILED on 424fe7e4 / ee29b5ac / b2b2559e: 77 `Custom(84)` forever, 78 `Custom(21)`); on 07a1d0eb it PASSES: 84 before the harvest, 78 before terminal-flat still 21, 78 after terminal-flat lands, then 77 pays |
| `limits_ui_repro_control_harvest_before_resolve_redeems` | control for the repro: same sequence with 78 run while Live => the redemption pays (10,142,985) |

Run against BOTH wrapper builds of each head, results identical every time:
- `07a1d0eb`: mine `f6eec5dd1a44d6c32bd0daed339f67386fb2b1e963ce51526326a1fb5f7d4ccd`; RELAUNCH `8410a5d7e85528bd8ac4a32c3ca5b0c6aa5c6a7ced3499855c252286005c71cc` (P3 lane), 5/5 pass on both;
- `b2b2559e`: this worktree's `cargo build-sbf --features devnet` (Solana 3.1.15) sha256 `d13498d9cab395b98053b47b65fd5128c978d7e27ad8bea63313395e98749a85`, and the RELAUNCH artifact (the P3 lane's `target/deploy`, reproduced 3x by that lane) sha256 `94e77a35116f66aeb26122ded9fe6d121ded6645cff5832b68c59606ac1273c0`, copied into `target/deploy/` for the run and then restored;
- `ee29b5ac` (superseded): `99fa011c…` (mine) and `608d3f8c…` (then-relaunch).
The bytes differ by build path (known: bytecode is path-dependent); behaviour does not.

App-side negative controls that re-run THIS scenario (scratch `negctl/run5.py`): deposit without the
bound tail -> `NotEnoughAccountKeys`; close-empty rent to the closer -> `Custom(8)`; 101 junior dest =
payer's ATA -> `Custom(11)`; each restored byte-identical and green after.

```bash
cargo build-sbf --features devnet
LIMITS_APP_DIR=<percolator-launch>/app TSX_BIN=<percolator-launch>/node_modules/.bin/tsx \
  cargo test --release --test p3_vault_lp -- limits_
```
