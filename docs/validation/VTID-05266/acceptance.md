# VTID-05266 — VTID-05082 staging suite: look for the SVG sanitizer in svg-preview.js
Plan: `.kiro/specs/fix-4182-test-fallout/` (branch `kiro/fix-4182-test-fallout/plan`), lane `staging-test-05082`,
converged in session 2 round 2 (PLAN-SPAR run 39464206815), approved by policy `converged-auto-v1`.
Test data only: `docs/validation/VTID-05082/staging-tests.json` test #3 and its `note`, plus this pack. No product code.
#4182 (`5aef4396c`) moved `sanitizeSvgMarkup` from `operator-console.js` (frozen by the VTID-05072/05073 guards) into
`services/gateway/src/frontend/command-hub/svg-preview.js`; the manifest was never updated, so every gateway
STAGING-VERIFY since #4182 failed this test (e.g. run 39456004226, 21/22).
This lane deploys nothing (`docs/validation/**` is not a gateway deploy path), so it has no Gate 2. The proof is the
STAGING-VERIFY run of the next gateway deploy that contains it, normally lane `jest-05077-cachebuster`, which merges after this one (R1-F1).

AC-1: VTID-05082 test #3 targets `/command-hub/svg-preview.js?v=20261121-vtid-05082` and still expects 200 and `sanitizeSvgMarkup`; staging serves exactly that.
CURL: GET https://preview-aws-gateway.vitanaland.com/command-hub/svg-preview.js?v=20261121-vtid-05082 -> 200, length 17084, contains `sanitizeSvgMarkup` (outputs/staging-get.txt)

AC-2: VTID-05082 tests #1 and #2 are unchanged; no test removed and no assertion loosened (rule 50).
TEST: git diff origin/main -- docs/validation/VTID-05082/staging-tests.json (outputs/diff-vtid-05082-manifest.txt: only `note` and test #3 `name`/`path`/`reason` change)

AC-3: Every `asset?v=` pin in a staging suite (VTID-05082 and VTID-05266) matches a version `index.html` loads.
TEST: services/gateway/test/vtid-04696-staging-checks-follow-asset-bumps.test.ts (outputs/jest-vtid-04696.txt: 1 suite, 1 passed)

AC-4: Both manifests parse and pass `lib.validateManifest` with their own `vtid` and `service: "gateway"` (task A6, local only).
TEST: node -e JSON.parse + lib.validateManifest from scripts/ci/staging-verify/lib.cjs (outputs/json-parse.txt, outputs/validate-manifest.txt)

Outputs: `outputs/json-parse.txt`, `outputs/validate-manifest.txt`, `outputs/staging-get.txt`, `outputs/jest-vtid-04696.txt`,
`outputs/diff-vtid-05082-manifest.txt`.
