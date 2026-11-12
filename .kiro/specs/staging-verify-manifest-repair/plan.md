---
change_class: standard
---
# plan(staging-verify-manifest-repair): repair the 14 stale change suites that fail the nightly full gateway STAGING-VERIFY
Author: Kiro, seat `hotmail`, session `kiro-hotmail-202611061752-cc1f`. Repo: `exafyltd/vitana-platform`.
Premises pinned to `origin/main` `4de8c4820e`; every `file:line` below was read on that commit.
<!-- plan:begin -->
## 1. Goal
Owner task (read-only investigation, 2026-11-07): the nightly full STAGING-VERIFY on gateway fails 13 to 14 tests
(run 42194962687 on `9069accecc94`: 13/1329; run 42356989808 on `ffaf66f695`: 14/1351). None is a product regression:
each is a stale change suite (a manifest in `docs/validation/<VTID>/staging-tests.json`) whose assumption stopped
being true. Repair each suite so it checks the **same property at its new location or in the real current state**.
No probe is deleted or weakened; the one suite that probes a removed behaviour is retired only with evidence, named
below. Done = a full gateway STAGING-VERIFY run on a deployed commit that contains every lane fails none of the 13
suites below; VTID-04880 stays red until the owner action in §3 lane `locale-zh-gap` (a truthful red, not a stale probe).

## 2. Today (evidence, all on `4de8c4820e`)
1. **VTID-05331 manifest invalid.** `docs/validation/VTID-05331/staging-tests.json:7` has
   `ref: "node --test scripts/collab/queue.test.mjs scripts/collab/plan-spar.test.mjs scripts/collab/plan-driver.test.mjs scripts/collab/automations.test.mjs"`.
   `scripts/ci/staging-verify/lib.cjs:123` `EXISTING_REF = /^(npm run [\w:.-]+|npx (jest|vitest run)( [\w./@:=-]+)*)$/`
   rejects it (`lib.cjs:194`, `validateTest` `existing`); `lib.validateManifest` returns `ok:false` (reproduced
   locally). The ref came in with #4377 (`abe2d7a59f`). The four test files exist (`ls scripts/collab/*.test.mjs`).
   Root `package.json` has no collab script; its `scripts` block (lines 5-15) holds `test:*` entries, and root
   `package.json` is not a gateway deploy path (`lib.cjs:41-44`: `services/gateway/**` and the stage deploy workflow).
2. **Nine manifests probe the served `app.js` for code that moved.** VTID-05073 (#4121) extracted the Operator
   Console from `services/gateway/src/frontend/command-hub/app.js` into `operator-console.js`
   (`docs/validation/VTID-05073/staging-tests.json:17-27`; `index.html:31` loads
   `operator-console.js?v=20261121-vtid-05082` before `app.js` at `:32`). Read against the repo files (a node script over
   every `expect_body_contains` string; output kept in the lane evidence):

   | Manifest (probe index) | Strings no longer in `app.js` | Where they live now |
   |---|---|---|
   | VTID-04887 `tests[6]` | `fetch('/api/v1/ops/pipeline-summary', {` | `operator-console.js` (2 hits); the other five strings of that probe are still in `app.js` |
   | VTID-04975 `tests[4]` | `function renderOperatorEngineSwitch`, `function renderKiroThreadPanel` | `operator-console.js` |
   | VTID-04984 `tests[2]` | `function renderKiroModelSelect`, `function selectKiroModel` | `operator-console.js` |
   | VTID-04999 `tests[3]` | `function renderKiroKeyControls`, `function linkKiroKey`, `function revokeKiroKey` | `operator-console.js` |
   | VTID-05003 `tests[2]` | `function applyDefaultOperatorEngine`, `function renderKiroFallbackAction`, `function continueInOperator` | `operator-console.js` |
   | VTID-05004 `tests[1]` | `kiro-key-manage`, `kiro-key-ok`, `✓ Connected` | `operator-console.js` |
   | VTID-05064 `tests[1]` | `kiro-stopped-early` | `operator-console.js` (1) and `kiro-console.js` (1) |
   | VTID-05069 `tests[6]` | `window.PipelineTree.renderThreadCards(state.operatorActiveThreadId)`, `window.PipelineTree.threadDot(thread.id)` | `operator-console.js` (1 each) |
   | VTID-05071 `tests[3]` | `window.KiroConsole.waitingBadge(thread.id)` | `operator-console.js` |

   Not changed: VTID-05064 `tests[0]` (`chatTurnThreadId`, still in `app.js`, 3 hits) and every probe that already passes.
   Every index probe of every manifest (26 probes) already matches `index.html`.
3. **PM mode probes assume a mode that is no longer true.** `docs/validation/VTID-05277/staging-tests.json` and
   `VTID-05281/staging-tests.json` expect `/api/v1/project-manager/mode` to equal
   `{ok:true, enabled:true, mode:"live", executor_mode:"kiro_fallback"}`. The route
   (`services/gateway/src/routes/project-manager.ts:33-41`) returns `enabled: pmAgentEnabled()`, `mode: snapshot.mode`,
   `executor_mode: snapshot.fallback ? 'kiro_fallback' : 'claude_primary'`. Read-only GET of staging today:
   `{"ok":true,"enabled":false,"mode":"live","executor_mode":"claude_primary"}`. So **both `enabled` and
   `executor_mode` differ**, not only `executor_mode` (the briefing named only `executor_mode`). The runner's
   `expect_json` is exact equality per JSON path (`lib.cjs:404-410`); it cannot say "one of".
4. **VTID-04880 locale-coverage.** The manifest (`docs/validation/VTID-04880/staging-tests.json:5`) expects
   `{"status":"ok"}`. Read-only GET of staging today: `{"status":"degraded","reason":"incomplete_ga_locale","journey_incomplete":[{"locale":"zh","complete_rows":259,"expected":260}]}`.
   `evalLocaleCoverage` (`services/gateway/src/routes/ops-health-checks.ts:119-124`) is correct: it fed from
   `ci_vital_systems_health()` (`supabase/migrations/20261005090000_vtid_04880_archive_nav_catalog.sql:137-168`), which
   counts, per GA locale other than `en`/`de`, the canonical (`en`) topics whose six translatable fields are all
   non-empty. `zh` has 259 of 260. **The probe is right and the data has a real gap**: one journey topic is missing or has an
   empty field in `zh`. This is not a stale probe.
5. **VTID-04784 probes a deleted test.** `docs/validation/VTID-04784/staging-tests.json:4` runs
   `npx jest test/services/memory/vtid-04784-recall-shadow.test.ts`. VTID-05556 (#4701, `05364284a1`: "the legacy
   six-table read, ... the VTID-04784 recall shadow ... are removed") deleted it (`ls services/gateway/test/services/memory`
   has no such file). **`docs/validation/VTID-05007/staging-tests.json` runs the same deleted path** as one of four
   suites (not in the briefing; found by checking every manifest's jest paths against the tree). The surviving
   coverage of the same read path is `test/services/memory/recall-bridge-wiring.test.ts` (header: "recall() is the only
   read for an identified caller ... no legacy query (no fallback, no shadow)") and `recall.test.ts`, both already
   named by `docs/validation/VTID-05556/staging-tests.json:14`.
6. **Why it keeps happening.** Nothing in CI reads a manifest against the tree it describes. `STAGING-TESTS-REQUIRED.yml`
   runs only `lib.test.cjs`, and validates only the PR's own manifest. So a later change (a file split, a deleted test,
   a new ref rule) breaks old suites and only the nightly full run notices.

## 3. Lanes (all `vitana-platform`, `executor: kiro`, `seat: exafy`, `area: platform`)
Seat and area come from `docs/programs/areas.yaml` (`platform`: `scripts/**`, `services/**`; the manifest-only lanes
have no more specific area, so they take the same one). Reviewer `agent:vitana-lane-reviewer`. No lane path is a
protected gate file (`scripts/collab/protected-gate-files.json` was read: `STAGING-TESTS-REQUIRED.yml`, `lib.cjs`,
`lib.test.cjs`, `package.json` and `docs/validation/**` are not listed; `.github/**` is a governance path, so the one
lane that edits a workflow names it and gets a reviewer-agent accept like any governance-path lane).
Every lane's evidence goes to `docs/validation/<its own VTID>/` (hence the shared `docs/validation/VTID-*/**` glob, the
convention of earlier plans); each lane names the exact files it may otherwise change.

| Lane | Exact files | depends_on |
|---|---|---|
| `console-probes-a` | `docs/validation/VTID-04887/staging-tests.json`, `VTID-04975`, `VTID-04984`, `VTID-04999` (same file name) | none |
| `console-probes-b` | `docs/validation/VTID-05003/`, `VTID-05004/`, `VTID-05064/`, `VTID-05069/`, `VTID-05071/` `staging-tests.json` | none |
| `ref-05331` | `package.json` (one new script), `docs/validation/VTID-05331/staging-tests.json` | none |
| `pm-mode-probes` | `scripts/ci/staging-verify/lib.cjs`, `scripts/ci/staging-verify/lib.test.cjs`, `docs/validation/VTID-05277/staging-tests.json`, `docs/validation/VTID-05281/staging-tests.json` | none |
| `shadow-retired` | `docs/validation/VTID-04784/staging-tests.json`, `docs/validation/VTID-05007/staging-tests.json` | none |
| `locale-zh-gap` | `docs/validation/VTID-*/**` only (an investigation record in its own VTID folder); the VTID-04880 manifest is **not** changed | none |
| `drift-guard` | `scripts/ci/staging-verify/manifest-drift.test.cjs` (new), `.github/workflows/STAGING-TESTS-REQUIRED.yml` | `console-probes-a`, `console-probes-b`, `ref-05331`, `shadow-retired` |

Six lanes build in parallel (cap 6); `drift-guard` follows. Lanes touch disjoint files; the shared glob is evidence only.

### Lane `console-probes-a` and `console-probes-b`: probe the file that now holds the code
For each probe in the table of §2.2: keep its `name` meaning, `expect_status`, `expect_content_type` and **every
string**; change only the `path` of the strings that moved to `/command-hub/operator-console.js?v=20261121-vtid-05082`
(the exact token `index.html:31` loads). Concretely:
- VTID-04887 `tests[6]`: split into two probes. The existing app.js probe keeps its five strings (still in `app.js`);
  a new `operator-console.js` probe carries `fetch('/api/v1/ops/pipeline-summary', {`. Nothing is dropped.
- VTID-04975 `tests[4]`, 04984 `tests[2]`, 04999 `tests[3]`, 05003 `tests[2]`, 05004 `tests[1]`, 05064 `tests[1]`, 05069
  `tests[6]`, 05071 `tests[3]`: the whole probe's `path` moves to `operator-console.js`; its strings are unchanged.
  (VTID-05064's `kiro-stopped-early` is also in `kiro-console.js`; the probe says "console script", so it follows the
  Operator Console file, where the reply marking is rendered.)
- **Strengthening, so a split can never again hide a dropped script tag:** the existing `/command-hub/` index probe of
  each of these manifests (all but VTID-05064 have one; VTID-04887 has two, `tests[4]` and `tests[5]`) also expects
  `operator-console.js?v=20261121-vtid-05082`. VTID-05064 has no index probe, so it gets one expecting both script
  tags (`app.js?v=20261121-vtid-05082-vtid-05547` and `operator-console.js?v=20261121-vtid-05082`), read-only like the
  rest. No probe is removed.
- Each `existing` jest entry is untouched.
Unchanged by design: the served `?v=` tokens stay pinned to today's `index.html` (the existing convention, verified for
all 26 index probes). A future bump is caught by `drift-guard`'s index check, in CI, before merge.

### Lane `ref-05331`: a valid ref for the same four suites
`package.json` gets one script `test:collab-sequential-builders`:
`node --test scripts/collab/queue.test.mjs scripts/collab/plan-spar.test.mjs scripts/collab/plan-driver.test.mjs scripts/collab/automations.test.mjs`
(the same four files, same runner, nothing dropped). The manifest `ref` becomes `npm run test:collab-sequential-builders`
with its `cwd: "."` and `reason` unchanged. `npm run <script>` is allowed by `EXISTING_REF`; root `package.json` is
outside the gateway deploy paths, so nothing deploys. Same shape as `docs/validation/VTID-04629/staging-tests.json`
(`npm run test:nav-redirect`). **Deferred, not changed:** `docs/validation/VTID-05438/staging-tests.json:5` has the same
`node --test` ref class, but its manifest has no `service` and is a tooling-only suite outside the nightly range; it is
tracked as a follow-up in §6 and the `drift-guard` deliberately does not cover manifests without `service` + `tests`.

### Lane `pm-mode-probes`: mode-agnostic without loosening what is proved
A new optional runner key, `expect_json_in`: `{ "<json path>": [allowed values] }`, evaluated next to `expect_json`
in `evaluateHttp` (`lib.cjs:404`): the value at the path must be strictly equal (JSON-compared, like `expect_json`)
to one of the listed values; a missing path fails; `validateHttpTest` rejects a non-object, an empty list or a
non-array value (so a typo cannot turn a probe into a pass). `lib.test.cjs` gets the cases first, red on `main`.
Manifests VTID-05277 and VTID-05281 `PM reports Kiro-fallback mode` probe becomes **`PM mode route reports the executor
mode`**:
`expect_json: {"ok": true, "mode": "live"}` and
`expect_json_in: {"executor_mode": ["kiro_fallback","claude_primary"], "enabled": [true, false]}`.
What this still proves on the deployed build: the route is mounted, anonymous, JSON, `ok:true`, `mode:"live"`, and the
build serves the executor-mode enum the PM contract defines (`project-manager.ts:39`). What it no longer asserts is the
**value** `kiro_fallback`, because that value depends on the repo variable `CLAUDE_AVAILABLE` (not `false` today; read
via REST by `observe-live`) and not on the deployed commit. Both suites keep their `/alive`, `/status` 401 rejected
probe and their `existing` jest suites unchanged (`kiro-autonomy-fallback-proof.test.ts`, `observe-live.test.ts`),
which prove the `kiro_fallback` behaviour in-process, where the mode can be controlled. The `note`/`reason` texts are
corrected to say so. A suite that must pin a mode on staging would have to write the repo variable: forbidden.

### Lane `shadow-retired`: retire only the probe of a removed behaviour, with evidence
- **VTID-04784:** the `existing` entry `npx jest test/services/memory/vtid-04784-recall-shadow.test.ts` is replaced by
  `npx jest test/services/memory/recall-bridge-wiring.test.ts` (cwd `services/gateway`), whose reason says the shadow was
  removed by VTID-05556 (#4701, `05364284a1`; file deleted in that commit, `git log --diff-filter=D`) and that the
  surviving test pins that the ORB reads memory only through `recall()`. The `/alive` probe stays. The removed
  behaviour's evidence line (recall-shadow logs summarised by `scripts/memory/recall-shadow-report.sh`) is dropped from
  the reason with the same citation.
- **VTID-05007:** the path `test/services/memory/vtid-04784-recall-shadow.test.ts` is removed from its third `existing`
  entry's `ref` (the other three suites stay: `vtid-04452-staging-orb-recall-pinned`, `vtid-04525-conversation-flag-registry`,
  `recall`); the reason is corrected ("with the shadow still logging" no longer holds). Its `recall-bridge-wiring.test.ts`
  is **not** added there because VTID-05556's own manifest already runs it; adding it would duplicate, not protect.
- Retirement is per manifest and per path as above; no other manifest loses a test.

### Lane `locale-zh-gap`: investigate read-only, then hand the owner one decision
Read-only. Steps, each with evidence in `docs/validation/<lane VTID>/locale-zh-investigation.md`:
1. Re-read `GET /api/v1/ops/health/locale-coverage` on staging (public, unauthenticated, read-only) and record the body.
2. From the repo only, find what the 260th canonical topic is: the `en` overlay seed sources
   (`supabase/migrations/20260610130000_BOOTSTRAP_journey_checklist_translations.sql`,
   `supabase/migrations/data-fixups/20260821110000_VTID_03695_seed_missing_locale_content.sql`,
   `services/gateway/src/services/db-i18n/*`) against the `zh` path, and the merge that added it.
3. Name the missing topic key and field if the repo shows it. If only a database read can show it, a read-only
   `SELECT` is allowed (never any write); if the session has no read access, say so.
4. State the fix path: the db-i18n seeder run for `zh`, or a data-fixup migration file (the file may be written in
   the lane PR; **applying it is an owner stop**, `collaboration.md` §7d, because staging shares the production
   database). The lane never writes a row.
Outcome: the lane is `done` when the investigation record is merged and **one** five-part message with the recommended
action went to the owner. `docs/validation/VTID-04880/staging-tests.json` is **not** edited: the probe stays
`{"status":"ok"}`, exactly as strict as before. Expect that single suite to stay red until the owner acts.

### Lane `drift-guard`: CI reads every manifest against the tree it describes
New `scripts/ci/staging-verify/manifest-drift.test.cjs` (`node:test`, no dependencies), added to the existing
"Runner unit tests" step of `.github/workflows/STAGING-TESTS-REQUIRED.yml` (`node --test scripts/ci/staging-verify/lib.test.cjs scripts/ci/staging-verify/manifest-drift.test.cjs`). It walks
`docs/validation/*/staging-tests.json` (BOM-tolerant, like `loadManifest`) and fails with `VTID, probe, string` for these five checks:
1. a manifest with `service` in `{gateway, community-app}` and a `tests` array that `lib.validateManifest` rejects
   (would have caught VTID-05331);
2. an `http` probe of `/command-hub/<file>.js|.css` whose `expect_body_contains` string is not in
   `services/gateway/src/frontend/command-hub/<file>` (would have caught the nine);
3. a `/command-hub/` index probe whose string is not in `index.html` (a `?v=` bump that outruns a manifest);
4. an `existing` `npx jest|vitest run` ref whose file-like token (has an extension) does not exist under its `cwd`
   (would have caught VTID-04784/05007). Directory prefixes (`test/navigation`) and flags are skipped;
5. an `http` probe key outside the closed set `kind, name, target, method, path, expect_status, expect_content_type,
   expect_json, expect_json_in, expect_body_contains, rejected_probe, reason` (a typo such as `expect_json_inn` would
   otherwise be ignored and the probe would pass; the union of keys of all 883 http probes on `origin/main` is exactly
   this set, so the guard is green on the head).
Manifests without `service` + `tests` (the `not_verified_on_staging` shape of VTID-05438/05464/05507) and manifests of
`community-app` for rule 2 and 4 (their files are in the other repo) are skipped by construction; the test says so.
Red proof: run the test against the base manifests restored from `4de8c4820e` (`git show 4de8c4820e:<path>`): it
reports exactly the 12 manifests of §2.1, 2.2 and 2.5 (the PM and locale suites are not file-drift); green on the head.

## 4. Tests and commands
- Per fix lane: a node script (kept in `commands.log`, output in `outputs/`) that, for the lane's manifests, runs
  `lib.validateManifest`, checks every `expect_body_contains` string against the repo file the probe's path names, and
  checks every jest path exists: red on `origin/main`, green on the head.
- `pm-mode-probes`: `node --test scripts/ci/staging-verify/lib.test.cjs scripts/ci/staging-verify/workflow.test.cjs`
  (new cases in `lib.test.cjs` red on main; `workflow.test.cjs` already exists and is only run, not modified).
- `ref-05331`: `npm run test:collab-sequential-builders` passes; `lib.validateManifest` returns `ok:true`.
- `drift-guard`: `node --test scripts/ci/staging-verify/manifest-drift.test.cjs scripts/ci/staging-verify/lib.test.cjs`.
- Every lane: `node scripts/collab/preflight.mjs ...` before each push.

## 5. Measurement and the end point
No lane deploys anything (docs, `scripts/ci`, one root script and a workflow). The endpoint is the first **full**
gateway STAGING-VERIFY run on a deployed staging commit that contains every lane (the nightly, or a `workflow_dispatch`
with `service: gateway`, `full: true` that the driver may run under `collaboration.md` §7d). It must show none of the 13
repaired suites failing, and VTID-04880 as the only expected red until the owner acts on lane `locale-zh-gap`.
`docs/validation/<plan VTID>/timings.json` per `collaboration.md` §8b.

## 6. Risks and deferrals
- **Excluded by the owner brief:** the community-app spec `vitana-v1 tests/e2e/staging/vtid-04921-group-chat-latest.staging.spec.ts`
  fails because the staging account is not a member of "Alle Beisammen". Fixing it needs a write to the shared production
  database: forbidden (CLAUDE.md IF-THEN 31-32). Owner item, not in this plan.
- `expect_json_in` widens the runner by one key; the validator rejects malformed use, and the guard test pins both.
- The nine moved probes now depend on `operator-console.js` being served with a JavaScript content type, as VTID-05073's
  own probe already does.
- Deferred: VTID-05438 (`node --test` ref, no `service`) - same class as VTID-05331, outside the nightly range; to be
  repaired if it enters a range. Listed here so it is not forgotten.
- A new stale manifest from a later split is caught by `drift-guard` in the PR that causes it.

## Unchanged
Product code and routes (`project-manager.ts`, `ops-health-checks.ts`), `index.html`, every probe that passes today,
the VTID-04880 expectation, `PR-GATE.yml` and other protected gate files, production, every other manifest.
<!-- plan:end -->
