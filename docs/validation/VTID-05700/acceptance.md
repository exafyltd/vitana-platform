Change types: Backend, Infrastructure/CI.

# Acceptance — VTID-05700 (privacy-ledger-auth / lane `ledger-auth-enforce`)

Outcome: the production gateway deploy writes `LEDGER_WRITE_AUTH_MODE` into the task definition from the repository
variable `PROD_LEDGER_WRITE_AUTH_MODE`, defaulting to `log` when the variable is unset or empty. Production runs `log`
today (the middleware default), so merging changes nothing in production. When the owner sets the variable to
`enforce` and runs PUBLISH, an anonymous `POST /api/v1/vtid/allocate` gets 401 JSON and nothing is allocated.

AC-1: Red on base: the four new and changed tests in `services/gateway/test/vtid-04727-ledger-write-auth.test.ts` fail
  on `origin/main` 6dc6e1ba0c (4 failed, 24 passed); `commands.log`.
TEST: `git stash push -- .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml services/gateway/src/services/conversation/conversation-flag-pins.generated.ts && (cd services/gateway && CI=1 npx jest test/vtid-04727-ledger-write-auth.test.ts)` → exit 1 (`outputs/red-green.txt`)

AC-2: Production mode only from the variable: one `LEDGER_WRITE_AUTH_MODE` entry in `AWS-PROD-DEPLOY-GATEWAY.yml`,
  `value:$LWA` with `LWA="${PROD_LEDGER_WRITE_AUTH_MODE:-log}"`, one reference to `vars.PROD_LEDGER_WRITE_AUTH_MODE`,
  and no hardcoded `enforce` (test "staging pins enforce; production takes the mode only from …").
TEST: `cd services/gateway && CI=1 npx jest test/vtid-04727-ledger-write-auth.test.ts -t "production takes the mode only from"`

AC-3: Unset gives `log`, never an empty value: the step's own shell, run on a fixture task definition with the variable
  absent and with the empty string Actions renders for an unset variable, writes exactly one `LEDGER_WRITE_AUTH_MODE=log`
  and keeps the other entries (test "with the variable unset …").
TEST: `cd services/gateway && CI=1 npx jest test/vtid-04727-ledger-write-auth.test.ts -t "with the variable unset"`

AC-4: Enforce gives 401: the same step with the variable `enforce` yields `enforce`; with that mode, an anonymous
  `POST /api/v1/vtid/allocate` through the real `vtid` router (supertest, allocator gate and `fetch` mocked) answers 401
  `application/json` with `ok: false`, and neither the allocator gate nor `fetch` is called.
TEST: `cd services/gateway && CI=1 npx jest test/vtid-04727-ledger-write-auth.test.ts -t "with the variable enforce"`

AC-5: Contract: no route or middleware code changes; staging is unchanged (it still pins `enforce`); no workflow input
  is added (still 25). `conversation-flag-pins.generated.ts` records `prod: "dynamic"`, and
  `node scripts/conversation/generate-flag-pins.mjs --check` passes.
TEST: `node scripts/conversation/generate-flag-pins.mjs --check` (exit 0); the js-yaml count of `on.workflow_dispatch.inputs` gives base=25 head=25 (`commands.log`)

AC-6: Regression: the 109 gateway test files that name `AWS-PROD-DEPLOY-GATEWAY` (this one included), plus
  `vtid-04677-scheduled-notifications-auth` and `vtid-04525-conversation-flag-registry`: 110 suites, 1,414 tests, 0
  failed.
TEST: `cd services/gateway && CI=1 npx jest test/vtid-04727-ledger-write-auth.test.ts test/vtid-04677-scheduled-notifications-auth.test.ts test/services/conversation/vtid-04525-conversation-flag-registry.test.ts $(grep -rlE AWS-PROD-DEPLOY-GATEWAY test)` → exit 0

AC-7: Probe safety. The exact request STAGING-VERIFY builds for the probe (`httpRequestInit`, bearer
  `staging-verify.invalid.probe`, body `{}`), sent through the gateway's middleware order and the real tasks router with
  the real `optionalAuth`, answers 401 in `enforce` and 400 `INVALID_VTID_FORMAT` in `log` and `off`, and nothing leaves
  the process: no `fetch`, no JWKS download, no Supabase client call, no OASIS event, no active-day write. A control
  with a well-formed ES256 bearer shows that the watchers do see a JWKS download. The test also passes on base: it pins
  the handler order the probe relies on (`oasis-tasks.ts:555-563` before `:586`); with the format check removed it fails
  (`commands.log`).
TEST: `cd services/gateway && CI=1 npx jest test/vtid-04727-ledger-write-auth.test.ts -t "staging probe safety"`

- Staging proof: `staging-tests.json` has one `http` `rejected_probe`, `POST /api/v1/oasis/tasks/VTID-PROBE/complete`
  with STAGING-VERIFY's invalid bearer, expecting 401 (same middleware). `VTID-PROBE` is not a VTID, so a gateway that
  lost its pin answers 400 before any database call and writes nothing, and the probe still fails (AC-7). The Jest
  suite runs as an `existing` test. The allocate route is never probed on a live gateway. Owner decision 2026-11-11:
  `VTID-PROBE` replaces `VTID-00000`, which is well-formed and would reach the ledger read.
- No production deploy is dispatched and no repository variable is set by this lane. The switch is the owner's: read
  seven days of production logs for `ledger write would be rejected` and fix every legitimate caller, set
  `PROD_LEDGER_WRITE_AUTH_MODE=enforce`, PUBLISH. Rollback: delete the variable and PUBLISH again.
- Protected gate file: the owner's instruction of 2026-11-11 (item 5) plus a reviewer-agent accept on the current head.
- The diff stays inside the lane `paths` plus this evidence folder; no test is skipped or loosened. The old assertion
  "production does not set the mode" is replaced by a stricter one (AC-2), as the plan states.

Decisions taken:
1. The entry is written by its own step, `Build task-definition (ledger write auth mode)`, placed before step 2/2, in the
   pattern of the other `Build task-definition (…)` steps, instead of being added to an unrelated step. The operator's
   `env_overrides` (step 2/2) can still override it, as for every other pinned flag.
2. The step replaces any existing `LEDGER_WRITE_AUTH_MODE` entry instead of appending a second one.
