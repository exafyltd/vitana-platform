# Acceptance: build-class-retag-2 (VTID-05671, plan agentic-delivery late lane)

| # | Criterion | Evidence |
|---|---|---|
| A1 | The five `build-image:*` jobs tag `vitana-eng-build` (gateway, erp-bridge, kiro-runner, postgrest-aurora-proxy in platform-delivery; community-app in v1-delivery) | `outputs/build-class-retag-2-green.txt`: 29 of 29 generator tests pass |
| A2 | Red before the change: the new build-class test fails on the main class | `outputs/build-class-retag-2-red.txt`: 28 pass, 1 fail (`vitana-v1: build-image:community-app`) |
| A3 | Both CI files are regenerated; the diff is only the five tags | `node scripts/eng/pipeline-gen.mjs --check` exits 0; diff 5 added, 5 removed tag lines |
| A4 | Deploy-path test 14 against the regenerated CI files | `docs/validation/VTID-05546/outputs/build-class-retag-2-test14.txt`. The only failure is deploy-path's naming check (`name === '.build-image'`), widened in deploy-path step 5 |

Evidence for VTID-05546 is also in `docs/validation/VTID-05546/outputs/` (same red and green runs).
Not claimed here: image builds on a real `vitana-eng-build` machine. Merge gate: owner steps A2 and A3.
