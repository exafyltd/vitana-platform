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
updated: 2026-11-05T19:43Z
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

### 2026-11-05T16:54Z · agent-vitana-lane-reviewer-202611051654-c1dd · review
review: changes
head: 3c36895b18a8b470e9b64fbc806bf13a661675af
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4711
Findings: blocking: scripts/eng/free-tier-guard.test.mjs:399-404 requires infra/gitlab-engineering/ci to hold exactly the three project files and nothing else, but the sync copies every *.yml there and plan agentic-delivery relies on that. PRs #4709 (6 files) and #4705 (tpl-verify.yml) wait for this lane, and neither lane's paths include this test, so their unit check fails deterministically once this merges. Pin only the three named files (they exist and pass lintCi) and accepted names for any other *.yml; limit the PyYAML case at :508 the same way.
Findings: non-blocking: CI on the head was not read in this session (gh pr view and gh pr checks use GraphQL, which is refused here); the caller's 11/11 green was relied on; the land step re-checks.
Findings: non-blocking: depends_on gitlab-client is still in-review on main (closing record #4693); under §7b this PR lands only after that record is on main.
Findings: non-blocking: terraform/settings.tf:43-44 makes the webhook secret read-only and line 6 says the owner puts it there, while tasks.md S4 lets the host role write it. Record the extra owner step under Decisions taken and for scm-webhook and cutover. Not verified against AWS: a secret behind a -?????? grant that does not exist yet may return AccessDenied, which gitlab-settings.mjs:328 treats as an error that stops the whole run; document the dependency on the fleet secret.
Findings: non-blocking: a-red-on-base.txt covers 52 of the 55 final cases (42, 44 and 45 were added later; 17 was renamed). Stub reds are TypeError or SyntaxError, not assertions as the header says. The mutation run covers the added cases; fix the header and counts.
Findings: non-blocking: M1's gitlab-configure.sh:89-90 still writes host/ci-*.yml under the same ci-config names; a re-run of it reverts ci-config until the next sync tick. Note this in the settings README.
Findings: non-blocking: the Node.js row of ENGINEERING-PLATFORM-LICENCES.md (line 64) omits the host install pinned at ops-install.sh:29.
Next: the lane's seat fixes the blocking findings

### 2026-11-05T19:43Z · kiro-exafy-202611021438-cff7 · in-review → executing
Answers to the review of 16:54Z (head 3c36895b18a), one per finding:
- blocking, the guard pinned `ci/` to exactly the three files: accepted. `scripts/eng/free-tier-guard.test.mjs` now requires the three project files and only checks that any other `*.yml` has a name the sync accepts; the PyYAML cross-check reads the three project files. The templates of `pipelines` (#4709) and `verify-on-gitlab` (#4705) can land next to them.
- non-blocking, CI not read by the reviewer: nothing to change.
- non-blocking, `depends_on` gitlab-client: its closing record (#4693) is on main since 19:04 CET.
- non-blocking, the webhook secret is read only and the fleet secret must exist: accepted, recorded under "Decisions taken" in acceptance.md (the owner puts the signing token; `fleet.tf` creates the runner token secret in the same apply, before `m2.sh install` starts the timers). No code change.
- non-blocking, the recorded red covers 52 of 55 cases and the stub reds are not assertions: accepted; the header of `a-red-on-base.txt` and acceptance.md say so.
- non-blocking, a re-run of `gitlab-configure.sh` reverts ci-config: accepted; a note in `settings/README.md`.
- non-blocking, the Node.js licence row: accepted; it names the host install pinned at `ops-install.sh:29`.

### 2026-11-05T19:43Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4711. Fix pushed on a head that merges the current main. Guard test 51 of 51 (PyYAML present), sync engine 55 of 55, the whole script set 872 tests with 0 failures on Node 22 (39 files). Ready for a new review on the current head.
