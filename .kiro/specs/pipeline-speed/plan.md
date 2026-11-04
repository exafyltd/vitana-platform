---
change_class: standard
---
# plan(pipeline-speed): stop the PM bookkeeping commit storm and cancel superseded PR runs
Author: Kiro, seat `exafyltd`, Kiro Web session (owner task 2026-11-04, "fix VITANA delivery speed"). Repo:
`exafyltd/vitana-platform`. Premise pinned to vitana-platform `origin/main` `56281ad0b8`. Lane file: `lanes/pipeline-speed.md`.
Code already written on `kiro/pipeline-speed/pm-bookkeeping-idempotent` (commits `9519b394e9`, `07ab1c797c`, PR #4674,
not merged). That PR cannot pass `STAGING-TESTS-REQUIRED` or `validate-pr` until this plan allocates a VTID.
<!-- plan:begin -->
## 1. Goal
Cut the CI load and queue delay that the platform repo produces. Measured on 2026-11-04 from GitHub run and PR data:
- Of the last 1,000 platform workflow runs, 922 (92%) came from `pm-agent/*` bookkeeping branches. Only 42 came from
  `kiro/*` feature branches.
- The PM (`services/gateway/src/services/project-manager`, live on staging, `PM_MODE=live`) reads lane state from `main`
  but writes to the `pm-agent/<slug>` bookkeeping branch. While that PR is open, the same stale-lane decision fires on
  each tick. Example: `pm-agent/operating-workflow` has 23 distinct commits and 161 runs. Each commit writes the line
  `reassign lane jtadic→exafyltd (stale_ready, Claude unavailable)` again, so the lane file grows by one line per tick.
- Each push to a PR starts six or more heavy checks. Three PR workflows (`ENFORCE-FRONTEND-CANONICAL-SOURCE`,
  `PHASE-2B-NAMING-ENFORCEMENT`, `STAGING-TESTS-REQUIRED`) had no concurrency group, so superseded runs kept going.
- Queue depth on the platform repo rose from 156 queued runs (16:33 UTC) to 315 (16:52 UTC). Jobs waited about 7 minutes
  for a runner, so a PR's own checks sat in the queue behind the bookkeeping runs.

## 2. Today
- `services/gateway/src/services/project-manager/writers.ts` `GithubRepoFileWriter.write()` commits every change the
  decision asks for, with no check whether the bookkeeping branch already holds it.
- `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml`, `PHASE-2B-NAMING-ENFORCEMENT.yml`, `STAGING-TESTS-REQUIRED.yml` have no
  `concurrency:` block. `UNIT.yml` and `PR-GATE.yml` already use the per-PR cancel pattern (VTID-05353).
- A remaining, unfixed cause: `workflow_run` chains on `main` (TEST-SUITE → TEST-SUITE-RERUN) produced 24
  `startup_failure` runs in the sample. Not in this plan's scope; recorded in the lane log for a follow-up.

## 3. Change
Lane `pipeline-speed` (repo `exafyltd/vitana-platform`, one lane, executor kiro, reviewer agent):
- **L1, PM idempotency.** `writers.ts`: export `changeAlreadyRecorded(text, change)`. It is true when the fields the change
  sets already hold their values, no claim is left to release, and the newest log line equals `change.log`. `write()`
  skips the commit (and still ensures the bookkeeping PR is open) when it is true. W1 and W2 both use it.
- **L2, superseded runs.** The three workflows get `concurrency: group: <name>-${{ github.event.pull_request.number }}`
  with `cancel-in-progress: true`. `PHASE-2B-NAMING-ENFORCEMENT` uses `github.event_name == 'pull_request'` so runs on
  `main` are never cancelled.

Scope of the lane: `services/gateway/src/services/project-manager/writers.ts`,
`services/gateway/test/project-manager/observe-live.test.ts`, the three workflow files above, `docs/validation/VTID-*/**`.
Not in scope: `PR-GATE.yml`, `PLAN-SPAR.yml`, `AWS-PROD-*.yml`, `governance.ts`, `scripts/collab/queue.mjs`, `CLAUDE.md`,
`.kiro/agents/**` (protected or governance paths). The lane file stays path-free until `executing`, per the bootstrap
rule for plan PRs.

## 4. Tests
- `services/gateway`: `npx jest test/project-manager` → 11 suites, 211 tests passed on the code branch. Two new
  tests: a repeated change makes no commit; a changed log line or seat still commits.
- The three workflow files parse as YAML and carry the concurrency blocks.
- Staging proof (after merge, gateway deploy path): `npx jest test/project-manager`, recorded in
  `docs/validation/<VTID>/staging-tests.json`. Live proof: the platform queue depth and `pm-agent/*` share of new runs,
  before and after the staging deploy, from `gh api repos/exafyltd/vitana-platform/actions/runs`.

## 5. Unchanged
Protected gate files, the PM's modes (`PM_MODE` stays `live` on staging), merge rules (§7b), branch protection, every
stop case. No production deploy. No change to the VTID allocator.

## 6. Owner decision still open
Until this lane deploys to staging, the PM loop keeps producing commits. Containment options: (a) flip `PM_MODE` to
`dry_run` on staging, which also pauses the PM's own merges and reassignments for every team; (b) wait for the fix. The
owner decides (a) or (b). This plan does not change `PM_MODE`.
<!-- plan:end -->
