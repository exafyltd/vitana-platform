---
lane: v1-cutover
state: ready
next_actor: kiro
depends_on: [pipelines, deploy-path, verify-on-gitlab, merge-queue, gateway-delivery]
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - infra/gitlab-engineering/settings/gitlab-settings.json
  - scripts/eng/gitlab-settings.mjs
  - scripts/eng/gitlab-settings-cutover.test.mjs
  - scripts/eng/v1-cutover.sh
  - scripts/eng/v1-rollback.sh
  - scripts/eng/migrate-open-prs.mjs
  - scripts/eng/migrate-open-prs.test.mjs
  - scripts/eng/parity-report.mjs
  - scripts/eng/parity-report.test.mjs
  - scripts/eng/delivery-metrics.mjs
  - scripts/eng/delivery-metrics.test.mjs
  - scripts/eng/github-v1-workflows.json
  - scripts/eng/github-v1-workflows.test.mjs
  - infra/gitlab-engineering/RUNBOOK-v1-cutover.md
  - docs/validation/**
updated: 2026-11-04T20:50Z
---
# Lane: v1-cutover (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §8 wave 1 (shadow, rehearsal, cutover, open PRs, rollback) and the measurement of §10. Starts when the other five lanes and eng-gitlab-m2 lane settings are done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T20:50Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.
