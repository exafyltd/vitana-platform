---
lane: pipelines
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - config/delivery/**
  - scripts/eng/pipeline-gen.mjs
  - scripts/eng/pipeline-gen.test.mjs
  - scripts/eng/affected-parity.test.mjs
  - scripts/eng/services-parity.test.mjs
  - scripts/eng/fixtures/v1-pr-files.json
  - infra/gitlab-engineering/ci/tpl-checks.yml
  - infra/gitlab-engineering/ci/tpl-main.yml
  - infra/gitlab-engineering/ci/tpl-nightly.yml
  - infra/gitlab-engineering/ci/tpl-assist.yml
  - infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml
  - docs/validation/**
updated: 2026-11-04T20:50Z
---
# Lane: pipelines (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.3, §3.4, §3.6 (orchestration), §3.9 (jobs) and T3. Starts when eng-gitlab-m2 lane settings is done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T20:50Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.
