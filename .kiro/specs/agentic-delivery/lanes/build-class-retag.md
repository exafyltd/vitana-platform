---
lane: build-class-retag
state: executing
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
  - docs/validation/VTID-05546/**
updated: 2026-11-08T12:05Z
vtid: VTID-05643
claimed_by: kiro-exafy-202611081113-5a2e
branch: kiro/agentic-delivery/build-class-retag
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

### 2026-11-08T12:05Z · kiro-exafy-202611081113-5a2e · ready → executing
Claimed by seat exafy (VTID-05643 on main since 11:39Z). Red: `outputs/build-class-retag-red.txt`, the new test 29 fails on `vitana-v1: build-image:community-app` (the five jobs tag vitana-eng-main). Change: `pipeline-gen.mjs` tags build-image jobs `vitana-eng-build`; the old main-class pattern in test 13 no longer lists build-image, and it checks the build tag instead. Regenerated both CI files: the diff is five jobs, `vitana-eng-main` to `vitana-eng-build`; `--check` exit 0. Green: `outputs/build-class-retag-green.txt`, 29 of 29. Deploy-path test 14 on a tree with deploy-path's files: its only remaining failure is a naming check (`name === .build-image`) that rejects the concrete `build-image:<svc>` jobs. Recorded for deploy-path step 3 (its test file, outside this lane). With that name check widened, test 14 passes and the file is 21 of 21 (`outputs/build-class-retag-test14-green.txt`). Merge gate still open: the `vitana-eng-build` class must run (owner A2, A3).
