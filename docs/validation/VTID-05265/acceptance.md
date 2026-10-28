# VTID-05265 — Gateway Jest: update the stale app.js cache-key pin in the VTID-05077 test

Plan: `.kiro/specs/fix-4182-test-fallout/` (branch `kiro/fix-4182-test-fallout/plan`, PR #4222), lane
`jest-05077-cachebuster`, converged in session 2 (PLAN-SPAR run 39464206815), approved by policy `converged-auto-v1`.
Test-only change: no product file is edited. `services/gateway/src/frontend/command-hub/index.html:32` is the source of
truth for the `app.js` cache key (`?v=20261121-vtid-05082`, bumped by #4182 / VTID-05082); the test now follows it.
Lands after lane `staging-test-05082` (R1-F1), so this lane's STAGING-VERIFY run also proves the corrected VTID-05082 suite.

AC-1: `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:212` expects the shipped key `/command-hub/app.js?v=20261121-vtid-05082`; no other line of the file changes.
TEST: services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts — "VTID-05077 planner fallback rate on the autopilot screen › the spend route returns the planner summary and the screen shows it as a chip"

AC-2: Every `docs/validation/*/staging-tests.json` asset pin (including this lane's new suite) names a version that `index.html` loads.
TEST: services/gateway/test/vtid-04696-staging-checks-follow-asset-bumps.test.ts — "every asset version named in a staging suite is the one index.html loads"

AC-3: No Jest `toContain` pin under `services/gateway/test` and no `docs/validation/*/staging-tests.json` suite pin of the old key `app.js?v=20261120-vtid-05148` remains; the three pin locations (`index.html:32`, the test `:212`, this suite) all name `app.js?v=20261121-vtid-05082`.
TEST: git grep -n "20261120-vtid-05148" -- services/gateway/test "docs/validation/*/staging-tests.json" (exit 1, no match; outputs/pin-consistency.txt)

AC-4: The deployed staging `index.html` loads `app.js` with the key the test now pins.
CURL: GET https://preview-aws-gateway.vitanaland.com/command-hub/index.html → 200, body contains `/command-hub/app.js?v=20261121-vtid-05082` (read-only, staging only; outputs/staging-get-index-html.txt)

Out of scope (plan R2-F2): `index.html` and every other product file; the prose mention of the old key in
`docs/validation/VTID-05148/acceptance.md:13` (a historical CURL_PROOF record read by no gate) stays unedited.

Outputs: `outputs/jest-05077-04696.txt`, `outputs/typecheck.txt`, `outputs/pin-consistency.txt`,
`outputs/staging-tests-manifest.txt`, `outputs/staging-get-index-html.txt`.
