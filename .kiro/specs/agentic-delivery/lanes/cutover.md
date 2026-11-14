---
lane: cutover
state: ready
next_actor: kiro
depends_on: [pipelines, deploy-path, verify-on-gitlab, merge-queue, github-bridge, gateway-delivery]
executor: kiro
seat: exafyltd
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
updated: 2026-11-12T20:15Z
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
### 2026-11-12T20:15Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
