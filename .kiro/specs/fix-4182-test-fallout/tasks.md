# Tasks — fix-4182-test-fallout
Authoritative plan: `plan.md` (this folder). Lane files: `lanes/`.
VTID: allocated by PLAN-SPAR after approval (one per lane). Below, `<VTID>` is the lane's own allocated VTID.

Both lane PRs (VALIDATOR-CHECK runs on both, `.github/workflows/VALIDATOR-CHECK.yml:32-37`):
- Title `<VTID> (fix-4182-test-fallout/<lane>): <summary>`, naming only the lane's own VTID (`VALIDATOR-CHECK.yml:87`, `:318`;
  `scripts/ci/staging-verify/run.mjs:474-479`).
- Body carries `VALIDATION_PROFILE: gateway_backend`, `SCOPE_ALLOWLIST:`, `ACCEPTANCE:`, `MERGE_PAYLOAD_PREVIEW:`,
  `OASIS_IMPACT: no` (`VALIDATOR-CHECK.yml:94-106`).
- Evidence pack `docs/validation/<VTID>/`, modelled on `origin/main:docs/validation/VTID-05254/`: `acceptance.md`
  (every `AC-n` line followed within 12 lines by a `TEST:`/`CURL:`/`UI:` line, `:152-176`), `commands.log`,
  `outputs/` with at least one file (`:146-150`), and `staging-tests.json` with `"vtid": "<VTID>"`,
  `"service": "gateway"` (`scripts/ci/staging-verify/lib.cjs:187-196`), read-only `http` tests plus an `existing` Jest ref.

<!-- lane: staging-test-05082 -->
## staging-test-05082 — point the VTID-05082 suite at svg-preview.js (repo vitana-platform)
Allowed paths:
- `docs/validation/VTID-05082/staging-tests.json`
- `docs/validation/<VTID>/**` (the lane's own evidence pack and staging suite, rule 47)

- [ ] A1. In `docs/validation/VTID-05082/staging-tests.json`, test #3: set `path` to
  `/command-hub/svg-preview.js?v=20261121-vtid-05082` and `name` to "deployed svg-preview.js contains the SVG
  sanitizer/renderer", and update `reason` to name `svg-preview.js`. Keep `expect_status: 200` and
  `expect_body_contains: "sanitizeSvgMarkup"`. Leave tests #1 and #2 unchanged.
- [ ] A2. Same file: update `note` to say the renderer lives in `svg-preview.js` (loaded by `index.html`), not `operator-console.js`.
- [ ] A3. `docs/validation/<VTID>/staging-tests.json`, read-only, modelled on `docs/validation/VTID-05254/staging-tests.json`:
  GET `/alive` returns 200; GET `/command-hub/svg-preview.js?v=20261121-vtid-05082` returns 200 and contains
  `sanitizeSvgMarkup`; `existing`: `npx jest test/vtid-04696-staging-checks-follow-asset-bumps.test.ts`, cwd `services/gateway`.
- [ ] A4. `docs/validation/<VTID>/acceptance.md`: AC-1 test #3 targets `svg-preview.js` (`CURL:` the staging GET);
  AC-2 tests #1/#2 unchanged (`TEST:` `git diff origin/main -- docs/validation/VTID-05082/staging-tests.json`);
  AC-3 every suite pin matches `index.html` (`TEST:` the VTID-04696 Jest test). `commands.log` lists every command
  with its result; `outputs/` holds the JSON-parse output, the staging GET result and the VTID-04696 Jest output.
- [ ] A5. Open the PR with the title and body above (profile `gateway_backend`), after A6.
- [ ] A6. Structural check (s2 R1-F2), local only because check-pr skips this docs-only PR (`run.mjs:469-472`) and the
  VTID-04696 test checks only `asset?v=` pins: for each of `docs/validation/VTID-05082/staging-tests.json`
  (vtid `VTID-05082`) and `docs/validation/<VTID>/staging-tests.json` (vtid `<VTID>`), run
  `node -e "const lib=require('./scripts/ci/staging-verify/lib.cjs');const m=JSON.parse(require('fs').readFileSync('<file>','utf8'));const v=lib.validateManifest(m,{vtid:'<vtid>',service:'gateway'});if(!v.ok){console.error(v.errors.join('\n'));process.exit(1)}"`
  from the repo root (`validateManifest` at `scripts/ci/staging-verify/lib.cjs:187`). Record both results in
  `commands.log` and `outputs/`.

Acceptance:
- Both JSON files parse (`node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"`) and pass the A6
  `validateManifest` check.
- `cd services/gateway; npx jest test/vtid-04696-staging-checks-follow-asset-bumps.test.ts` passes.
- A read-only GET of `https://preview-aws-gateway.vitanaland.com/command-hub/svg-preview.js?v=20261121-vtid-05082`
  returns 200 and the body contains `sanitizeSvgMarkup`.
- The PR title names `<VTID>`; `docs/validation/<VTID>/` has `acceptance.md`, `commands.log`, `outputs/` and
  `staging-tests.json`; VALIDATOR-CHECK is green (STAGING-TESTS-REQUIRED reports nothing deploys).
- The diff touches only the allowed paths.
- Docs-only: no staging deploy, no Gate 2. Merges before `jest-05077-cachebuster`; the STAGING-VERIFY run of the next
  gateway deploy containing this fix (normally that lane's merge) is the proof, recorded in this lane's log.
<!-- lane: staging-test-05082 -->

<!-- lane: jest-05077-cachebuster -->
## jest-05077-cachebuster — update the stale app.js pin in the VTID-05077 test (repo vitana-platform)
Allowed paths:
- `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts`
- `docs/validation/<VTID>/**` (the lane's own evidence pack and staging suite, rule 47)

- [ ] B1. At `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:212`, change
  `expect(html).toContain('/command-hub/app.js?v=20261120-vtid-05148');` to
  `expect(html).toContain('/command-hub/app.js?v=20261121-vtid-05082');`. No other line changes. The value is
  copied from `services/gateway/src/frontend/command-hub/index.html:32`, which is not edited.
- [ ] B2. `docs/validation/<VTID>/staging-tests.json`, read-only: GET `/alive` returns 200; GET `/command-hub/index.html`
  returns 200 and contains `/command-hub/app.js?v=20261121-vtid-05082` (the value of `index.html:32`); `existing`:
  `npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts test/vtid-04696-staging-checks-follow-asset-bumps.test.ts`,
  cwd `services/gateway`.
- [ ] B3. Before opening the PR, check #4207 (`gateway-test-cachebust/fix-pin`). If it has already fixed `:212` on
  `main`, B1 is an empty diff: record that in the lane log and hand the lane back as done, with no PR.
- [ ] B4. Open the PR only after `staging-test-05082` has merged, so this lane's staging deploy carries the
  corrected VTID-05082 manifest and its STAGING-VERIFY run proves both lanes.
- [ ] B5. Pin consistency (R2-F2): `git grep -n "20261120-vtid-05148" -- services/gateway/test "docs/validation/*/staging-tests.json"`
  returns nothing, and the three places (`index.html:32`, the test `:212`, B2's suite) all name `app.js?v=20261121-vtid-05082`.
  Scope (s2 R1-F1): the grep covers only Jest `toContain` assertions under `services/gateway/test` and suite pins in
  `docs/validation/*/staging-tests.json`. The old key's prose mention in `docs/validation/VTID-05148/acceptance.md:13`
  (VTID-05148's CURL_PROOF record) is out of scope, read by no gate, and stays unedited.
- [ ] B6. `docs/validation/<VTID>/acceptance.md`: AC-1 `:212` expects the shipped key (`TEST:` the VTID-05077 file);
  AC-2 suite pins match `index.html` (`TEST:` the VTID-04696 test); AC-3 no old-key pin remains (`TEST:` the B5 grep).
  `commands.log` lists every command with its result; `outputs/` holds the Jest output and the grep result.
- [ ] B7. Open the PR with the title and body above (profile `gateway_backend`).

Acceptance:
- `cd services/gateway; npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts test/vtid-04696-staging-checks-follow-asset-bumps.test.ts` passes.
- The B5 grep returns nothing.
- The PR title names `<VTID>`; `docs/validation/<VTID>/` has `acceptance.md`, `commands.log`, `outputs/` and a
  `staging-tests.json` that parses and passes `validateManifest`; STAGING-TESTS-REQUIRED, VALIDATOR-CHECK and the
  TEST-SUITE gateway Jest job are green.
- The diff touches only the allowed paths.
<!-- lane: jest-05077-cachebuster -->

## Re-plan notes (session 2)
- R1-F1: lane order unchanged (B4); Lane A acceptance now also requires VALIDATOR-CHECK green.
- R1-F2: no task change.
- R2-F1: the shared "Both lane PRs" block plus A3–A5 and B2, B6, B7 (title VTID, body markers, full evidence pack, suite).
  Both lane files already allow `docs/validation/**` (which holds `docs/validation/<VTID>/**`); the "Allowed paths"
  above narrow it. The lane files themselves are unchanged: a `_plan` commit may not edit a lane file
  (`scripts/collab/queue.mjs:384`), and they defer to this file for steps (A1–A6, B1–B7 supersede their "A1–A3"/"B1–B3").
- R2-F2: B1/B2 name `index.html:32` as the source of the value, new B5 checks the three places, and the VTID-04696
  test joins both lanes' acceptance.
- s2 R1-F1: B5 states its grep scope and names `VTID-05148/acceptance.md:13` as an ungated prose leftover.
- s2 R1-F2: new A6 runs `validateManifest` locally on both Lane A suites; Lane A acceptance requires it.
