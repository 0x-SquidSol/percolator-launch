# P3 sim: the vault-owned-LP journey executing APP-BUILT instructions

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
