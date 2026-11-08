# Acceptance: build-class-retag (VTID-05643, plan agentic-delivery late lane)

| # | Criterion | Evidence |
|---|---|---|
| A1 | The five `build-image:*` jobs tag `vitana-eng-build` (gateway, erp-bridge, kiro-runner, postgrest-aurora-proxy in platform-delivery; community-app in v1-delivery) | `outputs/build-class-retag-green.txt` (test 13 and test 29, 29 of 29 pass) |
| A2 | Red before the change: the new test fails on the main class | `outputs/build-class-retag-red.txt` (28 pass, 1 fail) |
| A3 | Both CI files are regenerated, and the diff is only the five tags | `node scripts/eng/pipeline-gen.mjs --check` exits 0; the diff is 5 added and 5 removed `- "vitana-eng-…"` lines |
| A4 | Deploy-path test 14 (BuildKit daemon on the build class only) passes against the regenerated files | `outputs/build-class-retag-test14-green.txt` shows the naming check. The one line that fails is deploy-path's (`name === '.build-image'` rejects the concrete `build-image:<svc>` jobs). Deploy-path widens it in its own branch. |

Not claimed here: the image builds running on a real `vitana-eng-build` machine. That needs owner steps A2 and A3, which are the merge gate of this lane.
