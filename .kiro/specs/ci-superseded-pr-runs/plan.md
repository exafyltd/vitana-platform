---
change_class: standard
---
# plan(ci-superseded-pr-runs): cancel superseded PR runs and remove the queue pile-up

Owner, 2 Nov 2026 (Kiro Web): *"Critical PR checks should start within approximately 1–2 minutes during normal heavy
Kiro activity. Preserve required-check names. Do not change protected PR-GATE.yml or PLAN-SPAR.yml, do not alter
production workflows, only cancel superseded runs for the same PR, never cancel push-to-main or scheduled runs."*

<!-- plan:begin -->
## Goal
Stop superseded PR runs from waiting in the shared GitHub-hosted queue. On 2 Nov 2026 vitana-platform had 852 queued
runs, about 690 of them three trivial gates, and only 35 of 218 queued commit SHAs were still the head of an open PR.
vitana-v1 PR jobs waited a median of 90 to 100 minutes for a runner. This plan adds a per-PR concurrency group with
`cancel-in-progress` to the PR-triggered workflows that lack one, so a newer push cancels the older run of the same PR.

## Today (file:line evidence on origin/main)
- Platform: 38 of 45 PR-triggered workflows have no `concurrency:` block. The earlier count of 37 missed
  `ENFORCE-FRONTEND-CANONICAL-SOURCE`, whose `on:` is list-form. Seven have a block already, including `UNIT.yml`,
  `TEST-SUITE.yml` and `PHASE-2B-DOC-GATE.yml` (added by VTID-05353), which this plan does not touch (R1-F2). The gates
  without a block include `PHASE-2B-NAMING-ENFORCEMENT`,
  `STAGING-TESTS-REQUIRED`, `ENFORCE-FRONTEND-CANONICAL-SOURCE`, `VALIDATOR-CHECK`, 21 `SQL-*`, and others).
- v1: 6 of 11 PR-triggered workflows have none (`i18n-check.yml`, `STAGING-TESTS-REQUIRED.yml`, 4 `SQL-*`).
- `PR-GATE.yml` in both repos already has `cancel-in-progress: true` per PR and is not changed here.
- Measured on 2 Nov: 2 queued PR runs on a superseded SHA of PR #4599 were cancelled by hand, a pattern this plan makes
  automatic.

## Change
1. Each PR-triggered workflow in the lane paths gets the block below, inserted before its `jobs:` key:
   ```yaml
   concurrency:
     group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
     cancel-in-progress: ${{ github.event_name == 'pull_request' }}
   ```
   Pushes to `main` and scheduled runs fall into the `github.ref` group with `cancel-in-progress: false`, so they are
   never cancelled.
2. Workflow `name:` values, `on:` triggers, `paths:` filters, jobs and steps are byte-identical. Required check names
   are therefore unchanged.
3. Excluded by rule: `PR-GATE.yml`, `PLAN-SPAR.yml` (protected gate files, `scripts/collab/protected-gate-files.json`),
   and every `AWS-PROD-*.yml` (production).

## Lanes
- `v1-superseded-concurrency` (repo `exafyltd/vitana-v1`): 6 workflows.
- `platform-superseded-concurrency` (repo `exafyltd/vitana-platform`): 38 workflows.
Both lanes are independent (`depends_on: []`) and touch different repos, so they run in parallel.

## Tests and commands
- Each lane reads its own YAML (`node -e` with `js-yaml` or the repo's parser) and asserts: the `on:` tree is unchanged,
  the new block is present exactly once, and it sets `cancel-in-progress` only through `github.event_name`.
- Existing suites stay green: v1 `npm run test:unit`; platform `node --test` on the `scripts/collab` tests.
- Evidence per lane: `docs/validation/<VTID>/commands.log`, `acceptance.md`, `scope.json`, `staging-tests.json`.

## Measurement (collaboration §8b)
Before and after: count of queued runs per repo, the number of superseded PR runs cancelled automatically (runs
whose `headSha` is no longer an open PR head), and queue-to-start time of PR-GATE, STAGING-TESTS-REQUIRED,
VALIDATOR-CHECK and UNIT-TESTS, sampled from `gh api repos/.../actions/runs/<id>/jobs` (`created_at` to `started_at`).

## Risks
- Push-triggered runs to feature branches still queue. `VCAOP-CICD.yml` and `VCAOP-GUARDRAILS-CI.yml` run on pushes
  to `claude/**` and `feature/vcaop`. The block sets `cancel-in-progress` only for `pull_request` events, so rapid
  pushes to those branches do not cancel each other. This is deliberate: a push-triggered run can be a main-branch or
  manual run that must finish (R1-F3).
- A cancelled superseded run reports nothing for its old SHA. The newest run for the PR reports the required check
  name, so the merge gate still sees one result per check on the head.
- A required check that is cancelled mid-run and not re-created would block a merge. The group key is per PR and the
  newest push always starts a new run, so this does not happen for PR events.

## Unchanged
- Protected gate files, production workflows, deploy workflows, required check names, STAGING-VERIFY, the reviewer
  agent gate, and every test.
<!-- plan:end -->
