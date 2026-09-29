# F-3 sim: the #519 LiteSVM scenario executing APP-BUILT exits

Patch over `dcccrypto/percolator-prog` `fix/f3-market-freeze@dec380a0` (draft PR #519), with the engine at `35ddd692` as the sibling `../percolator`.

It adds `f3_app_built_owner_exits_reopen_market_after_single_bankruptcy` to `tests/indep_conservation_fuzz.rs`. For every holder, the test spawns `app/scripts/limits-parity/f3-app-ixs.ts`, which calls the app's `buildRebalanceCloseIxs`. It then executes those exact instructions, `[PermissionlessCrank(own portfolio), RebalanceReduce(|position|)]`, in one owner-signed transaction.

```bash
LIMITS_APP_DIR=<percolator-launch>/app TSX_BIN=<percolator-launch>/node_modules/.bin/tsx \
INDEP_WRAPPER_SO=<deployed v18.2 wrapper .so, sha256 4472b383…> \
INDEP_MATCHER_SO=<percolator-match 12bd671 .so> \
cargo test --release --test indep_conservation_fuzz -- f3_app_built_owner_exits
```
