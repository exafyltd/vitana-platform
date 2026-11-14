---
lane: build-class-retag
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/eng/pipeline-gen.mjs
  - scripts/eng/pipeline-gen.test.mjs
  - infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml
  - infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml
  - docs/validation/VTID-05546/**
updated: 2026-11-12T20:15Z
vtid: VTID-05643
---
# Lane: build-class-retag (repo vitana-platform)
Tasks in `tasks.md` (group `<!-- lane: build-class-retag -->`). Late lane of plan `agentic-delivery` (see the Late lanes note
in `plan.md`). VTID from PLAN-SPAR; never by hand.

Problem: the five `build-image:*` jobs tag `vitana-eng-main`, which has no unconfined seccomp or AppArmor profile. The BuildKit
daemon they start needs the unconfined profile, and only the build class (`vitana-eng-build`, deploy-path) gives it. Fix: the
generator tags those jobs with the build class. The two CI files are generated (`--check` exits 3 on any hand edit), so the
change goes into `pipeline-gen.mjs` and the files are regenerated.

Merge gate: this lane does not merge before the `vitana-eng-build` class runs (owner steps A2 and A3). Until then the five
jobs would wait for a runner with that tag.

## Log
### 2026-11-08T11:45Z · kiro-exafy-202611081113-5a2e · created → ready
Lane added through `_plan` (plan PR `plan(agentic-delivery)`, branch `kiro/agentic-delivery/plan-3`), by planner decision 1 of
2026-11-08. Next: PLAN-SPAR allocates its VTID; a builder of seat `exafy` claims it.

### 2026-11-08T11:39Z · ci-plan-spar · ready (VTID allocated)
VTID-05643 allocated after policy approval (converged-auto-v1).
### 2026-11-12T20:15Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
