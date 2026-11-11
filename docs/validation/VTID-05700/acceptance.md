Change types: Backend, Infrastructure/CI.

# Acceptance — VTID-05700 (privacy-ledger-auth / lane `ledger-auth-enforce`)

Outcome: the production gateway deploy writes `LEDGER_WRITE_AUTH_MODE` into the task definition from the repository
variable `PROD_LEDGER_WRITE_AUTH_MODE`, defaulting to `log` when the variable is unset or empty. Production runs `log`
today (the middleware default), so merging changes nothing in production. When the owner sets the variable to
`enforce` and runs PUBLISH, an anonymous `POST /api/v1/vtid/allocate` gets 401 JSON and nothing is allocated.

AC-1: Red on base: the four new and changed tests in `services/gateway/test/vtid-04727-ledger-write-auth.test.ts` fail
  on `origin/main` 6dc6e1ba0c (4 failed, 24 passed); `commands.log`.
AC-2: Production mode only from the variable: one `LEDGER_WRITE_AUTH_MODE` entry in `AWS-PROD-DEPLOY-GATEWAY.yml`,
  `value:$LWA` with `LWA="${PROD_LEDGER_WRITE_AUTH_MODE:-log}"`, one reference to `vars.PROD_LEDGER_WRITE_AUTH_MODE`,
  and no hardcoded `enforce` (test "staging pins enforce; production takes the mode only from …").
AC-3: Unset gives `log`, never an empty value: the step's own shell, run on a fixture task definition with the variable
  absent and with the empty string Actions renders for an unset variable, writes exactly one `LEDGER_WRITE_AUTH_MODE=log`
  and keeps the other entries (test "with the variable unset …").
AC-4: Enforce gives 401: the same step with the variable `enforce` yields `enforce`; with that mode, an anonymous
  `POST /api/v1/vtid/allocate` through the real `vtid` router (supertest, allocator gate and `fetch` mocked) answers 401
  `application/json` with `ok: false`, and neither the allocator gate nor `fetch` is called.
AC-5: Contract: no route or middleware code changes; staging is unchanged (it still pins `enforce`); no workflow input
  is added (still 25). `conversation-flag-pins.generated.ts` records `prod: "dynamic"`, and
  `node scripts/conversation/generate-flag-pins.mjs --check` passes.
AC-6: Regression: the 109 gateway test files that name `AWS-PROD-DEPLOY-GATEWAY` (this one included), plus
  `vtid-04677-scheduled-notifications-auth` and `vtid-04525-conversation-flag-registry`: 110 suites, 1,414 tests, 0
  failed.
- Staging proof: `staging-tests.json` has one `http` `rejected_probe`, an anonymous
  `POST /api/v1/oasis/tasks/VTID-00000/complete` expecting 401 (same middleware; VTID-00000 does not exist, so a gateway
  that lost its pin answers 404 and writes nothing), plus the Jest suite as an `existing` test. The allocate route is
  never probed on a live gateway.
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
