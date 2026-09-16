# VTID-03961 — Add env-only deploy_mode to AWS-PROD-DEPLOY-GATEWAY.yml

## Report

Immediately after VTID-03958 (PR #3346) added the generic `env_overrides`
input, checked what dispatching it would actually ship: prod
(`gateway.vitanaland.com`, commit `dc2d17d2`) was 30 merged commits behind
what staging currently serves, including several features never discussed
in this conversation (Commerce Partner Onboarding, a supplier self-service
catalogue, an Aurora/Cognito cutover merge). Both existing `deploy_mode`s
(`promote-staging`, `rebuild-main`) always re-derive the shipped image from
staging's or main's current HEAD, so applying `env_overrides` via either
would also promote all 30 of those commits to production as a side effect —
exactly the scenario CLAUDE.md's Part 1 IF-THEN rule 26 says to stop and
flag rather than ship silently. Presented this to the platform owner with
two options; a narrow third `env-only` deploy mode was chosen.

## Acceptance Criteria

AC-1 — A new `env-only` `deploy_mode` choice value exists on the
already-existing `deploy_mode` input, WITHOUT adding a new top-level
`workflow_dispatch` input (the file must stay at 24 inputs, one below the
25-input ceiling VTID-03958 already fixed).

TEST: `test/vtid-03961-env-only-deploy-mode.test.ts` — "deploy_mode input
lists env-only as a third choice, not a new named input" asserts
`options === ['promote-staging', 'rebuild-main', 'env-only']` AND
`Object.keys(inputs).length === 24`. Also re-ran
`test/scripts/workflow-dispatch-input-limit.test.ts` (unmodified) — still
green. See `outputs/tests-and-tsc.txt`.

AC-2 — Under `env-only` mode, the "Resolve deploy source" step never
contacts the AWS staging service and never checks out/builds from `main` —
it reads back the CURRENT `ECS_SERVICE` task definition's own image and
`GIT_COMMIT_SHA` and echoes them as this run's source, so the deploy ships
byte-for-byte the same application code that is already live.

TEST: `test/vtid-03961-env-only-deploy-mode.test.ts` — extracts the REAL
step script (not a reimplementation) and asserts, by string position, that
env-only's branch `exit 0`s before the promote-staging section's
`STAGING_URL` curl is ever reached; a second test executes the real script
under a stub `aws` CLI and confirms `mode=env-only`,
`image=<the current image, unchanged>`, `sha=<the current commit,
unchanged>`.

AC-3 — Under `env-only` mode, the only thing a dispatch can change is
`env_overrides` (or another dispatch-input override) — never the
application code/image.

TEST: covered structurally by AC-2 (image/commit pass through unchanged)
combined with VTID-03958's own `env_overrides` tests (unchanged, still
green) — the "Build task-definition (2/2)" step's env_overrides block is
untouched by this PR and still the only mutation path.

AC-4 — A missing/unresolvable current image fails the run loudly rather
than silently proceeding with an empty or wrong image; a missing
`GIT_COMMIT_SHA` degrades to a recorded `"unknown"` marker rather than
crashing the step.

TEST: `test/vtid-03961-env-only-deploy-mode.test.ts` — "fails loudly...
when the current image cannot be resolved" (non-zero exit, `::error::`
line present, no `mode` output written) and "falls back to sha=unknown...
when the current task def has no GIT_COMMIT_SHA" (exit 0, `sha=unknown`).

AC-5 — `promote-staging` and `rebuild-main` behavior is byte-for-byte
unchanged by this PR.

TEST: `test/vtid-03961-env-only-deploy-mode.test.ts` — "rebuild-main mode
is unaffected by the new env-only branch" (still selects
`mode=rebuild-main`); full gateway suite re-run (925/926 suites, 1
pre-existing skip, 15,200 tests passing, 0 failures) confirms no other
regression. See `outputs/tests-and-tsc.txt` and `commands.log`.

## Explicitly not covered

No route is added or removed (a CI/CD workflow file, not application code)
— no `ROUTE_MOUNT:`/`FINAL_URL:`/`CURL_PROOF:` evidence applies.
`OASIS_IMPACT: no` in the PR body. No AWS mutation performed — only
read-only `describe-services`/`describe-task-definition` calls during
investigation, and a stub `aws` inside the test harness. No workflow was
dispatched and this PR is not merged by this change itself; actually
applying `env_overrides` to production is the next, separate step once
this PR merges and staging (auto-deployed on merge, per this repo's
staging-first governance) has it.
