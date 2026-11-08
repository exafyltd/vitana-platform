---
lane: build-class-retag-2
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
vtid: VTID-05671
claimed_by: kiro-exafy-202611081113-5a2e
branch: kiro/agentic-delivery/build-class-retag-2
repos: [exafyltd/vitana-platform]
paths:
  - scripts/eng/pipeline-gen.mjs
  - scripts/eng/pipeline-gen.test.mjs
  - infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml
  - infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml
  - docs/validation/**
updated: 2026-11-08T13:20Z

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

### 2026-11-08T12:42Z · ci-plan-spar · ready (VTID allocated)
VTID-05671 allocated after policy approval (converged-auto-v1).

### 2026-11-08T13:20Z · kiro-exafy-202611081113-5a2e · ready → executing
Claimed by seat exafy (VTID-05671 on main since 12:48Z). Red: outputs/build-class-retag-2-red.txt (28 pass, 1 fail). Change: pipeline-gen.mjs tags build-image jobs vitana-eng-build; test 13 classifies build-image as build class. Regenerated both CI files: five tags, --check exit 0. Green: outputs/build-class-retag-2-green.txt (29 of 29). Deploy-path test 14 against these files: only the naming check fails (outputs/build-class-retag-2-test14.txt); deploy-path widens it in its step 5. Merge gate open: the vitana-eng-build class must run (owner A2, A3).
