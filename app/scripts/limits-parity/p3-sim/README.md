# P3 sim: the vault-owned-LP journey executing APP-BUILT instructions

Patch over `dcccrypto/percolator-prog` `feat/p3-vault-owned-lp@b2b2559e` — the FINAL combined head
(P1 `3acb34ae`; tag 94 path A only, path B removed 2026-09-30) — with engine `35ddd692` as the
sibling `../percolator` and the matcher `.so` from `percolator-match@12bd671` at
`../percolator-match/target/deploy/`. Earlier runs on `424fe7e4` and `ee29b5ac` gave identical
results (program code for this surface is unchanged). It appends to `tests/p3_vault_lp.rs`:

| test | what it proves (real wrapper + matcher BPF, LiteSVM) |
|---|---|
| `limits_app_p3_end_to_end` | every app-sent instruction comes from `app/scripts/limits-parity/p3-app-ixs.ts`, i.e. the SAME lib code the hooks call: wizard M4p (`buildP3BindIxs`: createAccount + 94 path A + 96); bound Earn deposit (`earnTxPlan` + `buildEarnDepositIxs`, tail [11]/[12]); live redemption with the P3-K1 harvest (`buildEarnExecuteIxs`: 78 + 77, tail [13]/[14]); the whole resolved sweep planned from RAW account bytes (`planResolvedExit` + `exitStepIxs`: 101 -> 8(owner = registry) -> 30 permissionless -> 8 -> ready) and the resolved redemption. Negative controls in-test: the deposit with its tail stripped is refused; 77 without the prepended 78 fails `VaultLpHarvestPending` (84). Conservation (`assert_conserved`) holds. |
| `limits_app_p3_own_cleanup_before_reclaim` | E2E B12 app side: the trader's OWN portfolio on a Resolved market via the app's owner-signed group (`planOwnPortfolioCleanup`, bridge `own-cleanup`): 30 + 8 in ONE tx, `materialized_portfolio_count` 2 -> 1, payout 19,700,000 to the owner's ATA, conservation holds |
| `limits_app_p3_blocks_resolved_harvest_lock` | the app's plan refuses the resolved redemption (reason `harvest-locked-after-resolve`) and the sweep plan reports `harvest-pending` |
| `limits_ui_repro_resolved_redemption_with_pending_fees` | PROGRAM FINDING repro: fees harvestable at resolution => after a full terminal-flat sweep, 77 fails `Custom(84)` and 78 fails `Custom(21)` (Live-only) — Earn seniors cannot redeem. Expected to FAIL on 424fe7e4 |
| `limits_ui_repro_control_harvest_before_resolve_redeems` | control for the repro: same sequence with 78 run while Live => the redemption pays (10,142,985) |

Run against BOTH wrapper builds of each head, all four results identical every time:
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
