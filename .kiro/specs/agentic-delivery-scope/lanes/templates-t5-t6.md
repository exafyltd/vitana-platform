---
lane: templates-t5-t6
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: jtadic
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - infra/gitlab-engineering/ci/tpl-publish.yml
  - infra/gitlab-engineering/ci/tpl-ops.yml
  - scripts/eng/pipeline-gen.mjs
  - scripts/eng/pipeline-gen.test.mjs
  - infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml
  - infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml
updated: 2026-11-11T16:49Z
vtid: VTID-05745
---

# Lane: templates-t5-t6 (repo exafyltd/vitana-platform)

Templates T5 (publish) and T6 (ops-job), inert until the cut. Tasks in `tasks.md`.

## Log
### 2026-11-11T16:23Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T16:49Z · ci-plan-spar · ready (VTID allocated)
VTID-05745 allocated after policy approval (converged-auto-v1).
