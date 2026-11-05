Change types: Backend, Tooling/docs.

# VTID-05551 acceptance (agentic-delivery/prerequisites)
Lane `prerequisites` of plan `agentic-delivery` (vitana-platform), tasks R1-R3 of `.kiro/specs/agentic-delivery/tasks.md`;
plan §9 (the atlas drift guard) and §3.6 step 4 (the `WORKFLOW` input). Builder session `kiro-exafy-202611050324-2956`
(seat exafy), base `origin/main` `0ca24febdb`.

Outcome: the two route files the GitLab lanes add, `routes/internal-gitlab-webhook.ts` (eng-gitlab-m2 lane
`scm-webhook`) and `routes/delivery.ts` (this plan's lane `gateway-delivery`), pass the atlas drift guard
(`test/vtid-04560-role-separation-regression.test.ts:524-529`) as soon as they land, because domain `deploy` already
claims them. Every STAGING-VERIFY row in OASIS can say which host verified it: `record-oasis.sh` writes `WORKFLOW` into
`metadata.workflow`, and GitHub's rows, where `WORKFLOW` is not set, stay byte for byte what they are today.

AC-1 `domainsForRoute('internal-gitlab-webhook.ts')` (the drift guard's form) and `domainsForRoute('internal-gitlab-webhook')`
return exactly one domain, `deploy`.
TEST: services/gateway/test/atlas-gitlab-route-claims.test.ts "internal-gitlab-webhook.ts is claimed by domain deploy, and only by it".

AC-2 `domainsForRoute('delivery.ts')` and `domainsForRoute('delivery')` return exactly one domain, `deploy`.
TEST: services/gateway/test/atlas-gitlab-route-claims.test.ts "delivery.ts is claimed by domain deploy, and only by it".

AC-3 The drift guard's walk over today's `src/routes` files plus the two new files finds no unclaimed file, and the
drift guard itself stays green: `npm run test:roles` passes (CLAUDE.md NEVER 42h).
TEST: services/gateway/test/atlas-gitlab-route-claims.test.ts "the drift guard passes for today's route files plus the two new ones"; `npm run test:roles` (105 tests).

AC-4 The two new patterns are anchored at both ends (`/^internal-gitlab-webhook$/`, `/^delivery$/`): near-miss names
(`delivery-old`, `my-delivery`, `deliveryx`, `internal-gitlab-webhook-v2`, `x-internal-gitlab-webhook`, `gitlab-webhook`)
are not claimed by domain `deploy`. No other part of `domain-atlas.ts` changes.
TEST: services/gateway/test/atlas-gitlab-route-claims.test.ts "the new claims match the exact file names only".

AC-5 Without `WORKFLOW`, `record-oasis.sh` sends a body byte-identical to the one the script on `origin/main` sends for
the same `results.json`, with `metadata.workflow: "STAGING-VERIFY.yml"`: for a passed run (today's results.json shape),
a failed run in the older shape (no `full`, `superseded_by`, `attribution_cutoff`, `chain`; `vtid: null`), and a
superseded full run with attributed results.
TEST: scripts/ci/staging-verify/record-oasis-workflow.test.mjs "<case>: without WORKFLOW the body is byte-identical to today's" (passed, failed, superseded).

AC-6 The crashed-runner body (no `results.json`) follows the same rule: byte-identical to today's without `WORKFLOW`,
and with `WORKFLOW` set only `metadata.workflow` differs.
TEST: scripts/ci/staging-verify/record-oasis-workflow.test.mjs "the crashed runner (no results.json): …" (3 tests).

AC-7 With `WORKFLOW=gitlab:vitana/vitana-v1/staging-verify` the body differs from today's only in `metadata.workflow`:
the bytes equal today's bytes with that one field's value replaced (same keys, same order), the parsed bodies are equal
once `metadata.workflow` is removed, and the exit status and log line are the same as without `WORKFLOW`.
TEST: scripts/ci/staging-verify/record-oasis-workflow.test.mjs "<case>: with WORKFLOW=gitlab:vitana/vitana-v1/staging-verify the body differs only in metadata.workflow" (4 cases).

AC-8 An empty `WORKFLOW` behaves as unset: the body is today's, with `STAGING-VERIFY.yml`.
TEST: scripts/ci/staging-verify/record-oasis-workflow.test.mjs "<case>: an empty WORKFLOW behaves as unset" (4 cases).

AC-9 `WORKFLOW` reaches jq as data (`--arg workflow`), never as program or shell text: a value with jq interpolation
(`\(env.SUPABASE_SVC)`), a double quote, `$(…)` and backticks is recorded literally, the service key never reaches the
body, and no shell command runs.
TEST: scripts/ci/staging-verify/record-oasis-workflow.test.mjs "WORKFLOW reaches jq as data, never as program or shell text".

AC-10 GitHub's STAGING-VERIFY job keeps its inputs: `.github/workflows/STAGING-VERIFY.yml` sets no `WORKFLOW` and still
runs the script, so GitHub rows keep the default; every existing `record-oasis.sh` behaviour stays (body from a file,
not argv; missing credentials and a failed POST fail the step; the body file is removed).
TEST: scripts/ci/staging-verify/record-oasis-workflow.test.mjs "GitHub STAGING-VERIFY.yml sets no WORKFLOW, so its rows keep the default"; scripts/ci/staging-verify/record-oasis.test.cjs (9 tests, unchanged).

OASIS_PROOF: the script writes one `oasis_events` row per STAGING-VERIFY run (`POST $SUPABASE_URL/rest/v1/oasis_events`,
`record-oasis.sh:63`): `vtid` (the run's VTID or `BOOTSTRAP-STAGING-VERIFY`), `topic` `staging.verify.passed|failed|superseded`,
`service` `staging-verify-<service>`, `role` `CICD`, `model` `staging-verify`, `status`, `message`, and `metadata`
{env, service, commit, outcome, vtids, run_url, production_commit, results, missing_suites, invalid_suites, shipping,
full, workflow, superseded_by, attribution_cutoff, chain}; the crashed-runner row is `staging.verify.failed` with
`metadata` {env, service, commit, outcome, run_url, crashed, workflow}. Without `WORKFLOW` (every GitHub run:
`STAGING-VERIFY.yml:199-210` sets none) the row is byte-identical to today's, `metadata.workflow: "STAGING-VERIFY.yml"`.
With `WORKFLOW` set (the GitLab `.record` job of lane `verify-on-gitlab`) only `metadata.workflow` differs, e.g.
`"gitlab:vitana/vitana-v1/staging-verify"`. The PUBLISH gate's reader, `services/gateway/src/services/testing/publish-gate.ts`,
selects `created_at, topic, metadata` where `topic like 'staging.verify.%'`, `metadata->>service` and `metadata->>commit`
match, newest first, limit 10 (`publish-gate.ts:133-140`); `pickVerificationRow` decides on `topic` (`:118-120`); and
`toVerification` reads `metadata.service`, `commit`, `results` and `run_url` (`:56-69`). It never reads
`metadata.workflow` (the file does not contain the word). The other readers of these rows read topic, created_at,
service, commit, production_commit, vtids, run_url and results, never `workflow`: `routes/testing.ts:178-202`,
`services/operator-runs/run-view.ts:971-993` (`loadVerifyEvents`, which Gate 2 uses through
`services/project-manager/gate2.ts:252-255`), `services/project-manager/observe-live.ts:732`,
`services/ops-attention-adapters.ts:457-512` and `routes/ops-runtime-health.ts:390`. The only `metadata?.workflow` read
in `services/gateway/src` is `routes/testing.ts:366`, on `testing.run.launched` rows. No row was written to verify this
lane: the tests send the body to a fake curl and `https://example.invalid`.

States: `WORKFLOW` unset (today's value `STAGING-VERIFY.yml`, body byte-identical); `WORKFLOW` empty (as unset);
`WORKFLOW` set (that value, only `metadata.workflow` differs); the crashed-runner path (the same three rules); a value
with quotes, jq or shell syntax (recorded literally). Atlas: a route file named exactly `internal-gitlab-webhook` or
`delivery` (claimed by `deploy`); a near-miss name (not claimed by these patterns).

Surfaces: callers of `domainsForRoute` (`src/orb/developer/domain-atlas.ts:223-226`), which today are tests only: the
drift guard, `test/app-config.test.ts:205`, `test/health-erasure-internal.test.ts:432-433`,
`test/ops-pipeline-summary.test.ts:193`. The developer assistant's atlas tools (`src/orb/developer/deep-dive.ts:217`,
`src/services/orb-tools/developer-knowledge-tools.ts:36-55`, `src/services/gemini-operator.ts:3639-3647`) render keys,
titles, summaries, code, tables, flags and docs, not `routes`, so nothing they show changes. The STAGING-VERIFY workflow
(`.github/workflows/STAGING-VERIFY.yml`, unchanged inputs). Readers of `oasis_events` `staging.verify.*` (see OASIS_PROOF).

Locales: n/a. Accessibility: n/a.

Contract: the atlas entry shape (`AtlasDomain`, `domain-atlas.ts:15-32`) and `domainsForRoute` (`:223-226`) are
unchanged; domain `deploy` (`:83-94`) gains the two patterns in `routes` and nothing else. `record-oasis.sh` keeps the
environment of its header (`SUPABASE_URL`, `SUPABASE_SVC`, `RESULTS`, `RUN_URL`, `SERVICE`, `SHA`; lines 4-6) plus the
optional `WORKFLOW`, passed to both jq programs with `--arg workflow "${WORKFLOW:-STAGING-VERIFY.yml}"`
(`record-oasis.sh:34,47` and `:55,59`); the POST, its headers and the log line are unchanged. `npm run test:roles` stays
green (CLAUDE.md NEVER 42h).

Staging proof: the gateway smoke suite on the deployed staging build plus `staging-tests.json`: `/alive` 200 and the
`existing` suite `npx jest test/atlas-gitlab-route-claims.test.ts test/vtid-04560-role-separation-regression.test.ts`
(cwd `services/gateway`) on the verified commit. Not verified on staging beyond that: the atlas has no read endpoint,
so the claims are not observable on staging; the atlas test and the drift guard cover them. `record-oasis.sh` deploys
nothing: proven by `record-oasis-workflow.test.mjs` in UNIT; its next real run is the next GitHub STAGING-VERIFY, which
must record the same body as before. `run.mjs check-pr` prints "change suite present and valid for VTID-05551".

Red on base (`origin/main` `0ca24febdb`, the final tests with the base `domain-atlas.ts` and `record-oasis.sh`):
`outputs/red-on-base-atlas.txt` 4 tests, 3 failed, 1 passed (the near-miss test passes on base by design: nothing
claims those names there); `outputs/red-on-base-record-oasis.txt` 15 tests, 5 failed (the 4 `WORKFLOW` cases and the
data test), 10 passed (the 8 unset and empty cases pass on base, which proves the recorded bodies are the base script's
bytes for these fixtures).
Green (final code): `outputs/green-atlas.txt` 4/4; `outputs/green-record-oasis.txt` 15/15 (also 15/15 under jq 1.7.1,
`outputs/green-record-oasis-jq171.txt`); `outputs/test-roles.txt` 105/105; `outputs/typecheck.txt` exit 0; the new
jest file type-checked on its own with strict settings, exit 0; `outputs/staging-verify-scripts.txt` 5 files, 103/103;
`outputs/unit-all.txt` (UNIT.yml's command) 34 files, 628 tests, 627 pass, 0 fail, 1 skipped (a win32-only test in
`scripts/collab/workflow-watchdog.test.mjs`, not touched here), and the same counts under Node 20.20.2
(`outputs/unit-all-node20.txt`); `outputs/staging-existing-suite-local.txt` the `existing` suite in run.mjs's
environment, 109/109.

Decisions taken (for Gate 2):
- An empty `WORKFLOW` behaves as unset (`${WORKFLOW:-STAGING-VERIFY.yml}`): an empty `metadata.workflow` would name no
  host, and an empty value set by mistake keeps today's GitHub body.
- `WORKFLOW` is passed to each of the two jq programs with its own `--arg workflow`, no shared shell variable; the jq
  programs are otherwise unchanged. The header of `record-oasis.sh` documents `WORKFLOW` (its environment contract,
  lines 4-6, and one note). `domain-atlas.ts` gets only the two patterns, no comment.
- "Byte-identical to today's" is proven against today's bytes: the expected bodies were recorded once from the base
  script with `outputs/golden-bodies.mjs` (output `outputs/golden-bodies.txt`) and are the same under jq 1.7.1, the
  ubuntu-latest runner's jq, and jq 1.8.1, this machine's. The `WORKFLOW` case compares against those bytes with one
  field replaced.
- The test also pins the premise that GitHub's `STAGING-VERIFY.yml` sets no `WORKFLOW`; a later change that sets it on
  GitHub has to change this test on purpose.
- `staging-tests.json`: the `existing` test carries `"cwd": "services/gateway"`, because its jest paths are relative to
  the gateway and run.mjs runs an `existing` ref in `cwd`, default the repository root (`run.mjs:300-301`).
- `scope.json` lists the four lane files, the lane file `.kiro/specs/agentic-delivery/lanes/prerequisites.md` (this PR
  changes it) and `docs/validation/VTID-05551/**`, narrower than the lane's `docs/validation/**`.
