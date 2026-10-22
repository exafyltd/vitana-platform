# VTID-05301 — ci-health acceptance

Lane `ci-health` of plan `ci-github-modernization`. Daily CI-health report
(scheduled workflow + producer script + test). GitHub reads only — never a call
against any production service. Deploys nothing.

Each AC below is followed by its verification token (`TEST:` / `UI:`) within the
mapping window required by the VALIDATOR-CHECK Acceptance Mapping Gate.

AC-1: The producer computes per-workflow flake rate — a head SHA that concluded
`failure` and later `success` in the window counts as flaky; `flakeRate = flaky
heads / heads with any failure`.
TEST: node --test scripts/ci/health/report.test.mjs (flake-rate case) → pass

AC-2: The producer computes red-on-main age — for a workflow whose newest `main`
run concluded `failure`, the hours back to the oldest consecutive failing `main`
run; a green run before the streak does not extend it.
TEST: node --test scripts/ci/health/report.test.mjs (red-on-main age + green-latest cases) → pass

AC-3: The producer computes per-check median and p90 duration from each finished
run's `createdAt → updatedAt` wall time (nearest-rank p90).
TEST: node --test scripts/ci/health/report.test.mjs (duration percentile case) → pass

AC-4: The producer emits schema `vitana.ci-health/v1` and carries the coverage
gap (Playwright/e2e specs and shell/Python test scripts no required check runs)
even on an empty run set.
TEST: node scripts/ci/health/report.mjs --runs _empty.json --out _out.json → vitana.ci-health/v1, coverageGap x3
UI: n/a — the report publishes to the GitHub Actions job step summary and an uploaded `ci-health.json` artifact, not a user-facing screen.

AC-5: `.github/workflows/CI-HEALTH.yml` is a valid scheduled (`cron: '17 5 * * *'`)
+ `workflow_dispatch` workflow with `permissions: contents: read, actions: read`
and no deploy/AWS/production call.
TEST: node _yamlcheck.cjs .github/workflows/CI-HEALTH.yml → YAML OK

## Red → green
See `red-on-base.txt` (both source files absent on `origin/main`) and
`commands.log` (head green, `node --test …` → tests 9, pass 9, fail 0).

## OASIS impact
OASIS_IMPACT: no — this lane adds a scheduled CI-health report (reporting only).
It performs no OASIS task-state transition and emits no OASIS event, so no
`OASIS_PROOF:` applies.
