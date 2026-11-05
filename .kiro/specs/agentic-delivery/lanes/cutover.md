---
lane: cutover
state: in-review
next_actor: kiro
depends_on: [pipelines, deploy-path, verify-on-gitlab, merge-queue, github-bridge, gateway-delivery]
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - infra/gitlab-engineering/settings/gitlab-settings.json
  - scripts/eng/gitlab-settings.mjs
  - scripts/eng/gitlab-settings-cutover.test.mjs
  - scripts/eng/delivery-cutover.sh
  - scripts/eng/delivery-cutover.test.mjs
  - scripts/eng/delivery-rollback.sh
  - scripts/eng/parity-report.mjs
  - scripts/eng/parity-report.test.mjs
  - scripts/eng/delivery-metrics.mjs
  - scripts/eng/delivery-metrics.test.mjs
  - scripts/eng/github-workflows.json
  - scripts/eng/github-workflows.test.mjs
  - infra/gitlab-engineering/RUNBOOK-cutover.md
  - .kiro/pipeline/driver.md
  - .kiro/pipeline/lane-land.md
  - docs/validation/**
updated: 2026-11-05T23:01Z
claimed_by: kiro-exafy-202611021438-cff7
branch: kiro/agentic-delivery/cutover
pr: https://github.com/exafyltd/vitana-platform/pull/4725
vtid: VTID-05545
---
# Lane: cutover (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §8 (shadow, checklist, cut, rollback) and the measurement of §10. Starts when the other six lanes and eng-gitlab-m2 lane settings are done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T23:03Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.

### 2026-11-05T00:25Z · ci-plan-spar · ready (VTID allocated)
VTID-05545 allocated after policy approval (converged-auto-v1).
### 2026-11-05T02:53Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
### 2026-11-05T02:59Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)

### 2026-11-05T12:40Z · kiro-exafy-202611021438-cff7 · ready → executing
Claimed. Built on a stacked base (fleet, settings, merge-bot, monitoring) while those lanes were in review; rebuilt as one commit on origin/main after they merged. Tests first (103 cases on stand-ins for gh, aws, git and the GitLab machine). An independent pre-review found five blocking safety issues (B1 to B5); all fixed with tests red on the earlier code. Decisions taken inside the plan are in acceptance.md and the PR.

### 2026-11-05T23:01Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4725. Evidence from the final code: 103 cases green, 161 mutations all caught, the whole script set 1056 tests with 0 failures on Node 22 and Node 20, secret scan 0 matches. Ready for a review on the current head; depends_on lanes pipelines, deploy-path, merge-queue and gateway-delivery are not done yet, so it merges after them.
