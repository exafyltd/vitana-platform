---
lane: gitlab-verify
state: executing
next_actor: kiro
depends_on: [gitlab-infra]
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - docs/validation/**
  - infra/gitlab-engineering/host/ci-platform.yml
  - infra/gitlab-engineering/host/ci-v1.yml
  - infra/gitlab-engineering/RUNBOOK.md
updated: 2026-11-07T11:46Z
vtid: VTID-05555
claimed_by: kiro-exafy-202611071142-d7ed
branch: kiro/eng-gitlab-m1/gitlab-verify
---
# Lane: gitlab-verify (repo vitana-platform)
Tasks in `tasks.md` (group `<!-- lane: gitlab-verify -->`). Records the owner's runs of plan §6 steps 0 to 3 as evidence. VTID from PLAN-SPAR
(a late lane of the converged plan); never by hand.

## Log
### 2026-11-05T10:19Z · kiro-exafy-202611021438-cff7 · created → ready
Lane added through `_plan` (plan PR `plan(eng-gitlab-m1): …`, branch `kiro/eng-gitlab-m1/plan-2`). Why: see the `handoff.md` entry of the
same time. Next: PLAN-SPAR allocates its VTID; the lane starts when `gitlab-infra` is `done`.

### 2026-11-05T10:49Z · ci-plan-spar · ready (VTID allocated)
VTID-05555 allocated after policy approval (converged-auto-v1).

### 2026-11-07T11:46Z · kiro-exafy-202611071142-d7ed · ready → executing
Claimed by Kiro seat exafy. V1 done: the owner's steps are in `docs/validation/VTID-05555/owner-steps.md`. V4 started: `acceptance.md` maps A01-A05 and the pipelines clause, each PENDING on an owner output. The GitHub side of step 1 is recorded (`outputs/github-main-runs.txt`, both green). The step-2 list includes the nginx lines of the restored gitlab.rb (gitlab-infra review note on `host/gitlab-install.sh:49-53`).
Blocked on the owner: steps 0-3 run against the live GitLab and the engineering AWS account; a session never runs them. Next: the owner pastes each output; the lane records it (V2), fixes any defect (V3), then goes to in-review.

### 2026-11-07T12:37Z · kiro-exafy-202611071142-d7ed · executing (owner read 1 recorded)
The owner ran `bash ~/glv.sh read` in CloudShell (outputs/read-20261107T1234Z.txt; findings in outputs/read-1-findings.md). A03 passes (nightly backups 11-05, 11-06, 11-07). Step 0 is done by the M2 settings sync (ci-config hashes equal git main). Blocker: no runner serves tag `vitana-eng` since the M2 retag of `vitana-eng-1` to `vitana-legacy`; the fleet runner's token is not stored because every secret write of the settings sync fails (lane eng-gitlab-m2/settings-fix, PR #4780, held by kiro-exafy-202611062222-c262). Pipelines and A05 wait for it. The glv.sh runner line is fixed. Next: the owner runs `bash ~/glv.sh restore` (A04), which does not need a runner.

### 2026-11-07T12:54Z · kiro-exafy-202611071142-d7ed · executing (restore run 1 recorded; V3 fix to RUNBOOK §8)
Restore run 1 (outputs/restore-1-20261107T1239Z.txt): the 2026-11-07 backup restored on a scratch machine (`RESULT: DONE`, doctor:secrets 0 failures), and the machine was removed. A04 is not proven: step B discarded the result query's output (`2>/dev/null`), so there were no counts and no tip, and step C compared nothing. Fixed under V3 in `RUNBOOK.md` §8 and glv.sh: the query is retried, its error is kept, and a missing result fails the step. nginx lines recorded for the gitlab-infra note. Next: restore run 2 with the fixed commands.

### 2026-11-07T15:46Z · kiro-exafy-202611071142-d7ed · executing (restore run 2 recorded; second V3 fix)
Restore run 2 (outputs/restore-2-20261107T1514Z.txt): the restore completed again, and step B now failed loudly with the cause: `gitlab-rails runner` runs as user git and cannot read `/root/result.rb`. Fixed in `RUNBOOK.md` §8 and glv.sh: the query file is `/tmp/result.rb`. Scratch machine removed. Next: restore run 3.

### 2026-11-07T17:23Z · kiro-exafy-202611071142-d7ed · executing (A04 passes)
Restore run 3 (outputs/restore-3-20261107T1708Z.txt) passes A04: restored counts 4 1 10 equal live 4 1 10, and the restored main tip 1abd637af3 is in the live project. Status: A01 observed, A02 files on main, A03 passes, A04 passes. Still open: A05 and the green-pipeline comparison, blocked because no runner serves tag `vitana-eng` until eng-gitlab-m2/settings-fix (PR #4780) lands. Next: when settings-fix is merged, the owner runs `bash ~/glv.sh read` once more; then this lane goes to in-review.

### 2026-11-07T17:26Z · kiro-exafy-202611071142-d7ed · executing (owner read 2; blocked on the fleet runner)
Read 2 (outputs/read-2-20261107T1724Z.txt) confirms the blocker: runner `vitana-eng-fleet` (tag vitana-eng) has never contacted GitLab, and `vitana-eng-1` is online under tag vitana-legacy, so every main pipeline stays pending. A05 and the pipeline comparison wait for eng-gitlab-m2/settings-fix (PR #4780). Next: after the fleet runner is online, the owner runs `bash ~/glv.sh read` once more.

### 2026-11-07T18:09Z · kiro-exafy-202611071142-d7ed · executing (owner instruction: AWS work in the engineering account; fleet runner fixed)
authority: owner instruction 2026-11-07T18:0xZ in the conversation: "i am the owner and i give the instructions to execute all work in aws to migrate to gitlab". Scope taken: the engineering account 841276716213 and the GitLab migration only; nothing in production, Supabase or account 472838866351 workloads. Credentials: a 1-hour role session from the owner (ReadOnlyAccess plus SSM send-command), so the session can run commands on the engineering machines and read, but not change AWS resources themselves.
Write made: SSM command 8febb596-2b4c-4895-acb3-cd47cc2dd64a on the fleet manager i-05bf5e08fa12864a9: `apt-get install -y gitlab-runner-helper-images=19.5.2-1 gitlab-runner=19.5.2-1 && bash /opt/vitana/fleet-manager-install.sh`. Result: `== fleet manager install done 2026-11-07T18:05:51Z`, gitlab-runner active, runner vitana-eng-fleet verified, first contact 18:08:50Z; the autoscaling group started i-0a5d58a3f7ff3d278 and vitana-v1 pipeline 136 runs on it. Lasting fix in git (pin the helper in host/fleet-manager-install.sh:112 and host/runner-install.sh:26) is a new eng-gitlab-m2 lane through `_plan`. Observed: the group's MaxSize is 1, not fleet_max_instances 24.
