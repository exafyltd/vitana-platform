# Tasks - staging-verify-manifest-repair
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branch `kiro/staging-verify-manifest-repair/<lane>`; title
`VTID-xxxxx (staging-verify-manifest-repair/<lane>): ...`; trailers; `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.
Every fix lane keeps all existing probe strings and `existing` entries; nothing is deleted or weakened except where its
section names the retired path with evidence.

<!-- lane: console-probes-a -->
## Lane `console-probes-a`
- [ ] T1 A node check (kept in `commands.log`) over the four manifests: `lib.validateManifest`, every `expect_body_contains` string against the repo file the probe path names. Red on `origin/main`.
- [ ] T2 `VTID-04887`: split `tests[6]` into the app.js probe (five strings) and an `operator-console.js?v=20261121-vtid-05082` probe (`fetch('/api/v1/ops/pipeline-summary', {`).
- [ ] T3 `VTID-04975` `tests[4]`, `VTID-04984` `tests[2]`, `VTID-04999` `tests[3]`: change the probe `path` to `operator-console.js`, strings unchanged.
- [ ] T4 Each manifest's `/command-hub/` index probe also expects `operator-console.js?v=20261121-vtid-05082`.
- [ ] T5 The check green; `existing` entries byte-identical.

**Acceptance**
- Change types: Tooling/docs
- **Outcome** - CI (STAGING-VERIFY) finds the same Operator Console code it always checked, in the file that serves it; the four suites pass on staging.
- **States** - n/a: static probes. A missing file or string still fails the probe.
- **Surfaces** - Command Hub `/command-hub/` index, `operator-console.js`, `app.js`.
- **Locales** - n/a: no user text.
- **Accessibility** - n/a: no UI change.
- **Contract** - each probe: GET 200, content type `javascript`, `expect_body_contains` strings present in `services/gateway/src/frontend/command-hub/<file>` (`file:line` in the PR body).
- **Staging proof** - the four suites in the next full gateway STAGING-VERIFY; not verified on staging by this lane (deploys nothing); covered by the node check red on base and green on head.
- Only the four manifests and the lane's own evidence change; no string removed from any probe; no `existing` entry touched.

<!-- lane: console-probes-b -->
## Lane `console-probes-b`
- [ ] T1 The same node check over the five manifests, red on `origin/main`.
- [ ] T2 `VTID-05003` `tests[2]`, `VTID-05004` `tests[1]`, `VTID-05064` `tests[1]`, `VTID-05069` `tests[6]`, `VTID-05071` `tests[3]`: change the probe `path` to `operator-console.js?v=20261121-vtid-05082`, strings unchanged.
- [ ] T3 The `/command-hub/` index probe of 05003, 05004, 05069, 05071 also expects `operator-console.js?v=20261121-vtid-05082`; VTID-05064 gets a new index probe expecting both script tags.
- [ ] T4 The check green; `VTID-05064` `tests[0]` (`chatTurnThreadId`, still in `app.js`) and every `existing` entry unchanged.

**Acceptance**
- Change types: Tooling/docs
- **Outcome** - the five suites find the Kiro key, default-engine, stopped-early, pipeline-tree hook and waiting-badge code in `operator-console.js` and pass on staging.
- **States** - n/a: static probes.
- **Surfaces** - Command Hub index, `operator-console.js`, `app.js`.
- **Locales** - n/a: no user text.
- **Accessibility** - n/a: no UI change.
- **Contract** - GET 200, `javascript` content type, strings present in the named repo file (`file:line`).
- **Staging proof** - the five suites in the next full gateway STAGING-VERIFY; not verified on staging by this lane (deploys nothing); covered by the node check.
- Only the five manifests and the lane's own evidence change; no string or probe removed.

<!-- lane: ref-05331 -->
## Lane `ref-05331`
- [ ] T1 Record `lib.validateManifest(VTID-05331)` = `ok:false` on `origin/main` (red).
- [ ] T2 `package.json`: add `test:collab-sequential-builders` running the same four `scripts/collab/*.test.mjs` files with `node --test`.
- [ ] T3 `VTID-05331/staging-tests.json`: `ref` = `npm run test:collab-sequential-builders`, `cwd` `.`, `reason` unchanged.
- [ ] T4 `npm run test:collab-sequential-builders` passes; `validateManifest` returns `ok:true`.

**Acceptance**
- Change types: Tooling/docs, Infrastructure/CI
- **Outcome** - the sequential-builder suites VTID-05331 promised still run in STAGING-VERIFY, and its manifest is valid.
- **States** - n/a. A failing collab test still fails the suite.
- **Surfaces** - root `package.json` scripts; the STAGING-VERIFY `existing` runner.
- **Locales** - n/a. **Accessibility** - n/a.
- **Contract** - `EXISTING_REF` (`lib.cjs:123`) accepts `npm run <script>`; the script lists exactly the four original files.
- **Staging proof** - not verified on staging: nothing deploys (root `package.json` is not a gateway deploy path); covered by the red/green `validateManifest` record and the passing script.
- Only `package.json` (one script added, none changed) and the one manifest change.

<!-- lane: pm-mode-probes -->
## Lane `pm-mode-probes`
- [ ] T1 `lib.test.cjs` cases first, red on `main`: `expect_json_in` passes for a listed value, fails for an unlisted value and for a missing path; `validateHttpTest` rejects a non-object, an empty list and a non-array entry.
- [ ] T2 `lib.cjs`: evaluate `expect_json_in` in `evaluateHttp` next to `expect_json`; validate it in `validateHttpTest`.
- [ ] T3 `VTID-05277` and `VTID-05281`: the `PM reports Kiro-fallback mode` probe becomes `PM mode route reports the executor mode` with `expect_json {"ok":true,"mode":"live"}` and `expect_json_in {"executor_mode":["kiro_fallback","claude_primary"],"enabled":[true,false]}`; `note` and `reason` texts corrected; `/alive`, the `/status` rejected probe and the `existing` jest entries unchanged.
- [ ] T4 `node --test scripts/ci/staging-verify/lib.test.cjs scripts/ci/staging-verify/workflow.test.cjs` green (`workflow.test.cjs` is run, not modified); both manifests pass `validateManifest`.

**Acceptance**
- Change types: Tooling/docs, Integration
- **Outcome** - the PM mode suites pass whichever executor mode staging is in, and still fail if the route is unmounted, not JSON, not `ok:true`, not `live`, or reports a value outside the enum.
- **States** - `claude_primary` + `enabled:false` (today), `kiro_fallback` + `enabled:true` (earlier), a missing key, a typo'd value: each asserted in `lib.test.cjs`.
- **Surfaces** - the runner (`lib.cjs`), two manifests; callers: STAGING-VERIFY only.
- **Locales** - n/a. **Accessibility** - n/a.
- **Contract** - `GET /api/v1/project-manager/mode`: anonymous, 200, `application/json`, body `{ok, enabled, mode, executor_mode}` (`project-manager.ts:33-41`); `expect_json_in` strictly equal per listed value.
- **Staging proof** - the two suites in the next full gateway STAGING-VERIFY; the plan states the value `kiro_fallback` is no longer asserted on staging and is covered by `kiro-autonomy-fallback-proof.test.ts` and `observe-live.test.ts` (kept).
- The runner change is additive; `expect_json` behaviour byte-identical; no secret or `process.env` spread added.

<!-- lane: shadow-retired -->
## Lane `shadow-retired`
- [ ] T1 Record that `test/services/memory/vtid-04784-recall-shadow.test.ts` is absent on `origin/main` and was deleted by `05364284a1` (`git log --diff-filter=D`), and that `recall-bridge-wiring.test.ts` exists; check red on base.
- [ ] T2 `VTID-04784`: replace the deleted-path `existing` entry by `npx jest test/services/memory/recall-bridge-wiring.test.ts` (cwd `services/gateway`) with a reason citing VTID-05556 / #4701; keep `/alive`.
- [ ] T3 `VTID-05007`: remove only the deleted path from the third `existing` ref; correct the reason; the other three suites stay.
- [ ] T4 The existing-path check green for both; `recall-bridge-wiring.test.ts` passes in `services/gateway`.

**Acceptance**
- Change types: Tooling/docs
- **Outcome** - the two suites run only tests that exist and prove the surviving recall-only read path.
- **States** - n/a. **Surfaces** - the ORB memory bridge (`orb-memory-bridge`), via jest only. **Locales** - n/a. **Accessibility** - n/a.
- **Contract** - the retired probe's removal is named per manifest and per path with the deleting commit as evidence; no other manifest loses a test.
- **Staging proof** - `/alive` stays; jest suites run in CI-level `existing`; not verified on staging beyond that (read-only rule).
- Only the two manifests and the lane's evidence change.

<!-- lane: locale-zh-gap -->
## Lane `locale-zh-gap`
- [ ] T1 Record the staging `GET /api/v1/ops/health/locale-coverage` body (public, read-only).
- [ ] T2 From the repo, find the 260th canonical `en` journey topic and the `zh` path (seed sources listed in plan §3).
- [ ] T3 If only a database read shows it, one read-only `SELECT`; never a write. If no read access, say so.
- [ ] T4 Write `docs/validation/<lane VTID>/locale-zh-investigation.md`: topic key, field, the two fix paths (seeder run; data-fixup migration file) and which one is recommended.
- [ ] T5 Send the owner one five-part stop message (applying a fix is `collaboration.md` §7d stop 1 and the read/write rule stop 7). `VTID-04880` manifest untouched.

**Acceptance**
- Change types: Database (investigation only), Tooling/docs
- **Outcome** - the owner knows exactly which `zh` journey row is missing or empty, and gets one decision to make.
- **States** - gap in the repo seeds vs gap only in the database: both handled in the record.
- **Surfaces** - `ci_vital_systems_health()`, `/api/v1/ops/health/locale-coverage`, `journey_checklist_translations`.
- **Locales** - zh named; de and en are the reference (de excluded by VTID-03679).
- **Accessibility** - n/a.
- **Contract** - the query behind the check is quoted with `file:line`; the record states what the check counts.
- **Staging proof** - not verified on staging: the fix needs an owner-applied write; the probe stays strict and red until then.
- No database write, no probe edit, no migration applied. A migration file may be added only if the repo proves the gap, and its apply is the owner's stop.

<!-- lane: drift-guard -->
## Lane `drift-guard`
- [ ] T1 `manifest-drift.test.cjs` per plan §3 (checks 1-5, incl. the closed http-probe key set), written first; run against the base manifests restored from `4de8c4820e`: red naming the 12 manifests; record in `outputs/`.
- [ ] T2 Add the file to the "Runner unit tests" step of `STAGING-TESTS-REQUIRED.yml` (`node --test` with both files); keep `workflow.test.cjs` green.
- [ ] T3 On the head (all four fix lanes merged) the guard is green over all manifests.

**Acceptance**
- Change types: Tooling/docs, Infrastructure/CI
- **Outcome** - a PR that splits a served file, deletes a test or bumps a `?v=` token without updating the manifests fails in CI, not in the nightly run.
- **States** - BOM manifests; manifests without `service` + `tests` are skipped and the test says so; community-app manifests skip checks 2 and 4.
- **Surfaces** - `docs/validation/*/staging-tests.json`, `services/gateway/src/frontend/command-hub/*`, `services/gateway/test/**`.
- **Locales** - n/a. **Accessibility** - n/a.
- **Contract** - checks use `lib.validateManifest` and repo files only; no network; no write.
- **Staging proof** - not verified on staging: CI-only tool; the red-on-base / green-on-head record is the proof.
- A governance-path lane (`.github/**`): reviewer-agent accept on the current head; `PR-GATE.yml` and other protected gate files untouched; no test skipped or loosened.
