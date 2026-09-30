# P3 sim: the vault-owned-LP journey executing APP-BUILT instructions

Patch over `dcccrypto/percolator-prog` `feat/p3-vault-owned-lp@ee29b5ac` (the FINAL combined head,
P1 `3acb34ae`; engine `35ddd692` as the sibling `../percolator`; matcher `.so` from
`percolator-match@12bd671` at `../percolator-match/target/deploy/`). First run on `424fe7e4`
(identical program code for this surface). It appends to `tests/p3_vault_lp.rs`:

| test | what it proves (real wrapper + matcher BPF, LiteSVM) |
|---|---|
| `limits_app_p3_end_to_end` | every app-sent instruction comes from `app/scripts/limits-parity/p3-app-ixs.ts`, i.e. the SAME lib code the hooks call: wizard M4p (`buildP3BindIxs`: createAccount + 94 path A + 96); bound Earn deposit (`earnTxPlan` + `buildEarnDepositIxs`, tail [11]/[12]); live redemption with the P3-K1 harvest (`buildEarnExecuteIxs`: 78 + 77, tail [13]/[14]); the whole resolved sweep planned from RAW account bytes (`planResolvedExit` + `exitStepIxs`: 101 -> 8(owner = registry) -> 30 permissionless -> 8 -> ready) and the resolved redemption. Negative controls in-test: the deposit with its tail stripped is refused; 77 without the prepended 78 fails `VaultLpHarvestPending` (84). Conservation (`assert_conserved`) holds. |
| `limits_app_p3_blocks_resolved_harvest_lock` | the app's plan refuses the resolved redemption (reason `harvest-locked-after-resolve`) and the sweep plan reports `harvest-pending` |
| `limits_ui_repro_resolved_redemption_with_pending_fees` | PROGRAM FINDING repro: fees harvestable at resolution => after a full terminal-flat sweep, 77 fails `Custom(84)` and 78 fails `Custom(21)` (Live-only) — Earn seniors cannot redeem. Expected to FAIL on 424fe7e4 |
| `limits_ui_repro_control_harvest_before_resolve_redeems` | control for the repro: same sequence with 78 run while Live => the redemption pays (10,142,985) |

Run against BOTH wrapper builds of the final head, all four results identical:
- this worktree's `cargo build-sbf --features devnet` (Solana 3.1.15): sha256 `99fa011cd72d5b8ad779745c90952fdb5a10db38b85c92aaea543de6dbd2a5c3`;
- the RELAUNCH artifact (P3 lane `target/deploy`, the bytes that deploy): sha256 `608d3f8cd98a03259ef1413c5e22c31e33d3d4b6d3e54669503c0f079aa91e96` (copied into `target/deploy/` for the run, then restored).
The bytes differ by build path (known: bytecode is path-dependent); behaviour does not.

App-side negative controls that re-run THIS scenario (scratch `negctl/run5.py`): deposit without the
bound tail -> `NotEnoughAccountKeys`; close-empty rent to the closer -> `Custom(8)`; 101 junior dest =
payer's ATA -> `Custom(11)`; each restored byte-identical and green after.

```bash
cargo build-sbf --features devnet
LIMITS_APP_DIR=<percolator-launch>/app TSX_BIN=<percolator-launch>/node_modules/.bin/tsx \
  cargo test --release --test p3_vault_lp -- limits_
```
