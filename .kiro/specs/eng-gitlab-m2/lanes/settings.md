---
lane: settings
state: in-review
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
updated: 2026-11-05T16:43Z
claimed_by: kiro-exafy-202611021438-cff7
branch: kiro/eng-gitlab-m2/settings
pr: https://github.com/exafyltd/vitana-platform/pull/4711
vtid: VTID-05542
---
# Lane: settings (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.3 and the documentation amendment. Starts when M1 lane gitlab-infra is done. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-03T19:40Z · kiro-exafy-202611021438-cff7 · ready
Lane created with the plan.

### 2026-11-04T19:35Z · ci-plan-spar · ready (VTID allocated)
VTID-05542 allocated after policy approval (converged-auto-v1).

### 2026-11-05T12:40Z · kiro-exafy-202611021438-cff7 · ready → executing
Claimed. Built in three parts that touched different files: the sync engine (`gitlab-settings.mjs`, its JSON and test), the host files (central CI files, installer, units, IAM, `m2.sh`, the Free-tier guard test) and the two documents. Started from the tip of the M1 branch (8bae0d492d4) while M1 (#4692) waited for its re-review, because `terraform validate` needs M1's `main.tf` in the tree (the lane text says it starts after `gitlab-infra`). This PR was opened after M1 merged, and the branch was rebuilt as one commit on `origin/main`. Tests first (red on an empty implementation: 51 of 52 and 46 of 51). Decisions taken inside the plan (listed for Gate 2): the sync rotates its own admin token under 10 days and `ops-install.sh` mints the first one; on the Free tier a changed branch-protection access level means delete and re-create of `main`; the central CI files are self-contained; the guard skips tests, documents and comments.

### 2026-11-05T16:43Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4711. Evidence regenerated from the final code: 55 + 51 cases (green 106 of 106), 124 + 139 mutations all caught, a full apply on the fake GitLab (66 calls, 36 writes; the second run 0 writes), Terraform `fmt`/`validate` for the new file alone and together with the fleet and monitoring files, `systemd-analyze verify` clean, the whole script set 745 tests with 0 failures on Node 22 and Node 20, 177 documentation links checked, secret scans 0 matches. Ready for a review on the current head. Open for the plan driver (also in the PR): acceptance A2's negative-control jobs live in no lane's paths, so `rehearsal.gitlab-ci.yml` carries only the job `unit`; the seed `package.json` for it is the `rehearsal` lane's.
