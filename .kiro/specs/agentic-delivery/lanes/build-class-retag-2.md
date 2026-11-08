---
lane: build-class-retag-2
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/eng/pipeline-gen.mjs
  - scripts/eng/pipeline-gen.test.mjs
  - infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml
  - infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml
  - docs/validation/**
updated: 2026-11-08T13:10Z
---
# Lane: build-class-retag-2 (repo vitana-platform)
Tasks in `tasks.md` (group `<!-- lane: build-class-retag-2 -->`). Late lane of plan `agentic-delivery`, replacing `build-class-retag`
(see the Late lanes note in `plan.md`). VTID from PLAN-SPAR; never by hand.

Problem: the five `build-image:*` jobs tag `vitana-eng-main`, which has no unconfined seccomp or AppArmor profile. Only the build
class (`vitana-eng-build`) gives the BuildKit daemon the unconfined profile. The CI files are generated (`--check` exits 3 on drift),
so the change goes into `pipeline-gen.mjs` and the files are regenerated.

Merge gate: not before the `vitana-eng-build` class runs (owner steps A2 and A3).

## Log
### 2026-11-08T13:10Z · kiro-exafy-202611081113-5a2e · created → ready
Lane added through `_plan` by planner decision of 2026-11-08 13:05Z. Next: PLAN-SPAR allocates its VTID; a builder of seat `exafy` claims it.
