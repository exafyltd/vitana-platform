---
lane: monitoring
state: in-review
next_actor: kiro
depends_on: [gitlab-client]
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - infra/gitlab-engineering/terraform/monitoring.tf
  - infra/gitlab-engineering/host/ops.d/20-cwagent.sh
  - infra/gitlab-engineering/host/units/vitana-ci-metrics.service
  - infra/gitlab-engineering/host/units/vitana-ci-metrics.timer
  - scripts/eng/ci-metrics.mjs
  - scripts/eng/ci-metrics.test.mjs
  - scripts/eng/monitoring-structure.test.mjs
  - docs/validation/**
updated: 2026-11-05T16:42Z
claimed_by: kiro-exafy-202611021438-cff7
branch: kiro/eng-gitlab-m2/monitoring
pr: https://github.com/exafyltd/vitana-platform/pull/4710
vtid: VTID-05539
---
# Lane: monitoring (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.6. Starts when M1 lane gitlab-infra is done. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-03T19:40Z · kiro-exafy-202611021438-cff7 · ready
Lane created with the plan.

### 2026-11-04T19:35Z · ci-plan-spar · ready (VTID allocated)
VTID-05539 allocated after policy approval (converged-auto-v1).

### 2026-11-05T12:40Z · kiro-exafy-202611021438-cff7 · ready → executing
Claimed. Built from the tip of the M1 branch (8bae0d492d4) while M1 (#4692) waited for its re-review, because `terraform validate` needs M1's `main.tf` in the tree (the lane text says it starts when `gitlab-infra` is done). This PR was opened after M1 merged, and the branch was rebuilt as one commit on `origin/main`. Tests first (`monitoring-structure.test.mjs`, `ci-metrics.test.mjs`: red on the base and on a do-nothing stub), then `monitoring.tf`, `ci-metrics.mjs`, the two units and `20-cwagent.sh`. The first mutation run left 18 changes uncaught: 13 cases were added and 4 redundant pieces of code removed. Decisions taken inside the plan (listed for Gate 2): the topic has its own KMS key; the recipient falls back to `admin_email`; the budget mails the owner directly and defaults to 1000 dollars; "fleet at maximum" is read from GitLab; a "completed tick" is read with `systemctl show`.

### 2026-11-05T16:42Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4710. Evidence regenerated from the final code: 104 cases (red on base 38 of 38, red on a stub 67 of 67, green 104 of 104), 242 mutations all caught, `terraform fmt -check` and `terraform validate` with M1's `main.tf`, `systemd-analyze verify` clean, the whole script set 743 tests with 0 failures on Node 22 and Node 20, secret scan 0 matches. Ready for a review on the current head. Note for lane `settings`: `ops-install.sh` runs every `ops.d` script and logs a failing one without stopping the others.
