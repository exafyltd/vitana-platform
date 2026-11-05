---
lane: rehearsal
state: in-review
next_actor: kiro
depends_on: [gitlab-client, fleet, settings, merge-bot]
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/eng/rehearse.mjs
  - scripts/eng/rehearse.test.mjs
  - infra/gitlab-engineering/rehearsal/**
  - docs/validation/**
updated: 2026-11-05T23:00Z
claimed_by: kiro-exafy-202611021438-cff7
branch: kiro/eng-gitlab-m2/rehearsal
pr: https://github.com/exafyltd/vitana-platform/pull/4724
vtid: VTID-05540
---
# Lane: rehearsal (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.8. The owner's run of it is acceptance A1 to A4. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-03T19:40Z · kiro-exafy-202611021438-cff7 · ready
Lane created with the plan.

### 2026-11-04T19:35Z · ci-plan-spar · ready (VTID allocated)
VTID-05540 allocated after policy approval (converged-auto-v1).

### 2026-11-05T12:40Z · kiro-exafy-202611021438-cff7 · ready → executing
Claimed. Built on a stacked base (fleet, settings, merge-bot) while those lanes were in review; rebuilt as one commit on origin/main after they merged. Tests first (146 cases on a fake GitLab, a fake aws runner and a virtual clock). An independent pre-review found two blocking issues (the imds control, the host role's autoscaling rights); both fixed. Decisions taken inside the plan are in acceptance.md and the PR.

### 2026-11-05T23:00Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4724. Evidence from the final code: 146 of 146 green, 235 mutations all caught, the whole script set 995 tests with 0 failures on Node 22 and Node 20, secret scan 0 matches. Ready for a review on the current head.
