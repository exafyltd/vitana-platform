---
lane: settings
state: ready
next_actor: kiro
depends_on: [gitlab-client]
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - infra/gitlab-engineering/settings/**
  - infra/gitlab-engineering/ci/**
  - infra/gitlab-engineering/m2.sh
  - infra/gitlab-engineering/host/ops-install.sh
  - infra/gitlab-engineering/host/units/vitana-settings.service
  - infra/gitlab-engineering/host/units/vitana-settings.timer
  - infra/gitlab-engineering/host/units/vitana-platform-sync.service
  - infra/gitlab-engineering/host/units/vitana-platform-sync.timer
  - infra/gitlab-engineering/terraform/settings.tf
  - scripts/eng/gitlab-settings.mjs
  - scripts/eng/gitlab-settings.test.mjs
  - scripts/eng/free-tier-guard.test.mjs
  - docs/ENGINEERING-PLATFORM-PLAN.md
  - docs/ENGINEERING-PLATFORM-LICENCES.md
  - docs/validation/**
updated: 2026-11-04T19:35Z
vtid: VTID-05542
---
# Lane: settings (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.3 and the documentation amendment. Starts when M1 lane gitlab-infra is done. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-03T19:40Z · kiro-exafy-202611021438-cff7 · ready
Lane created with the plan.

### 2026-11-04T19:35Z · ci-plan-spar · ready (VTID allocated)
VTID-05542 allocated after policy approval (converged-auto-v1).
