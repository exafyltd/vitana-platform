# Acceptance: build-class-retag-2 (VTID-05671, plan agentic-delivery late lane)

AC-1 — The five `build-image:*` jobs tag `vitana-eng-build` (gateway, erp-bridge, kiro-runner, postgrest-aurora-proxy in platform-delivery; community-app in v1-delivery).
  TEST: `outputs/build-class-retag-2-green.txt`, 29 of 29 generator tests pass.

AC-2 — Red before the change: the new build-class test fails on the main class.
  TEST: `outputs/build-class-retag-2-red.txt`, 28 pass, 1 fail (`vitana-v1: build-image:community-app`).

AC-3 — Both CI files are regenerated; the diff is only the five tags.
  TEST: `node scripts/eng/pipeline-gen.mjs --check` exits 0; diff 5 added and 5 removed tag lines.

AC-4 — Deploy-path test 14 against the regenerated CI files.
  TEST: `docs/validation/VTID-05546/outputs/build-class-retag-2-test14-as-is.txt` shows the file as it is in deploy-path (exit 1): the one failing assertion is the naming check (`name === '.build-image'`), which rejects the concrete `build-image:<svc>` jobs that now carry the build tag.
  TEST: `docs/validation/VTID-05546/outputs/build-class-retag-2-test14-widened-check.txt` shows the same tree with only that naming line widened (deploy-path step 5): 21 of 21 pass, test 14 included.
  The widening itself is deploy-path's change (its test file), so it lands with deploy-path, not in this lane.

Not claimed here: image builds on a real `vitana-eng-build` machine. Merge gate: owner steps A2 and A3.
