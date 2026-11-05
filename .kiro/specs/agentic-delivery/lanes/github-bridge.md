---
lane: github-bridge
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/eng/github-bridge.mjs
  - scripts/eng/github-bridge.test.mjs
  - infra/gitlab-engineering/host/units/vitana-github-bridge.service
  - infra/gitlab-engineering/host/units/vitana-github-bridge.timer
  - infra/gitlab-engineering/RUNBOOK-github-bridge.md
  - docs/validation/**
updated: 2026-11-05T04:33Z
vtid: VTID-05548
claimed_by: kiro-exafy-202611050107-c4a6
branch: kiro/agentic-delivery/github-bridge
pr: https://github.com/exafyltd/vitana-platform/pull/4689
---
# Lane: github-bridge (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.13 (branches, pull requests, statuses). Starts when eng-gitlab-m2 lane gitlab-client is done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T23:03Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.

### 2026-11-05T00:25Z · ci-plan-spar · ready (VTID allocated)
VTID-05548 allocated after policy approval (converged-auto-v1).

### 2026-11-05T03:11Z · kiro-exafy-202611050107-c4a6 · ready → executing
Built `scripts/eng/github-bridge.mjs` (one tick: `kiro/*` and `claude/*` branches GitHub → GitLab under the one-writer rule, one merge request per open PR, `gitlab/<job>` statuses back, the PR closed with a link after landing; `assist-push`), the units `vitana-github-bridge.{service,timer}` and `RUNBOOK-github-bridge.md`.
Tests `scripts/eng/github-bridge.test.mjs`: red on base 49/49 failing against a no-behaviour stub (the module does not exist on base); green 49/49 on Node 20 and 22; UNIT 662 tests, 0 fail; mutation check 16/16 caught.
B3 dry run, read-only: 84 + 31 merge requests planned for 118 + 31 open PRs; 34 platform PRs ignored (33 `pm-agent/*`, 1 `i18n-db/*`).
Decisions and the open items for the driver: `docs/validation/VTID-05548/acceptance.md`.

### 2026-11-05T03:13Z · kiro-exafy-202611050107-c4a6 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4689 open; preflight passed. Next: the driver requests the reviewer agent.

### 2026-11-05T03:42Z · agent-vitana-lane-reviewer-202611050324-7146 · review
review: changes
head: 45dcdf534adf9ec3804fc9df02bc0a8d14daddc8
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4689
Findings: blocking: scripts/eng/github-bridge.mjs:96 posts a skipped job as GitHub success, including gate. When a check fails, gate does not run (tasks.md:78-79, lane pipelines), and the merge bot never passes a skipped or neutral required job (eng-gitlab-m2 plan.md:154-155). So gitlab/gate shows success on every merge request that cannot land, and GitHub and GitLab disagree on status. statusStep posts the gate jobs first (:917-918) and stops at the budget (:922) or a rate-limit pause (:921). At the plan's §5 load (about 1,150 job results an hour against a budget of 450), GitHub can show only success for a red pipeline, which plan-driver.mjs ghChecks reads as green. Fix: post every non-success result of lane-scope, change-suite and gate as non-success. Add a test (failed check plus skipped gate gives gitlab/gate failure; with a budget of 1, GitHub never shows only success for a red pipeline), recorded red on the current head first. Update acceptance.md AC-4 and the runbook.
Findings: non-blocking: CI on 45dcdf5 could not be read here (gh pr view and gh pr checks need GraphQL). The caller reported at 03:24Z that only wake had finished (success) and every other check was queued, none failed. The merge needs land-guard.mjs to show every check green on the merged head.
Findings: non-blocking: github-bridge.mjs:898 posts only settled jobs. While jobs run, GitHub can show only success, and a refused branch's pull request shows no gitlab/* status; ghChecks reads both as green. The runbook names the first case and landing is not affected. Option: one gitlab/gate pending status per head, plus one status on a refused head.
Findings: non-blocking: vitana-github-bridge.timer:16. eng-gitlab-m2 §3.3/§4 install every unit in host/units/* by glob, and m2.sh install sets up the timers. If ops-install.sh enables every timer, the bridge starts before the cut once both token files exist. Pin 'install, do not enable' in M2 settings and lane cutover, or add a start condition the cut sets.
Findings: non-blocking: plan §2.2 and §8.1 step 4 (every open pull request gets a merge request, including PRs of kept workflows) conflict with §3.13 and task B1 (kiro/* and claude/* only). 34 platform PRs (33 pm-agent/*, 1 i18n-db/*) get no merge request and cannot land after the cut. The plan needs a decision before the cut; this lane should not change.
Findings: non-blocking: dry-run-harness.mjs:30 serves branch heads from the PR snapshot and uses an empty GitLab. So B3 does not show the copy of agent branches without an open PR, and no status can come back. B3 is met; the §8.1 step 4 run stays a cut checklist item on the host.
Findings: non-blocking: three cross-lane items have no owner yet. (a) The bridge's GitLab account and token file. (b) Bridged pushes arrive as the bridge's account, so M2's 'accept pushed by agent-reviewer' check cannot pass for a bridged same-repo lane. (c) How an assist result reaches a protected refs/heads/assist/* ref, and who calls assist-push. The driver assigns each to M2 settings, merge-queue or cutover before the cut.
Findings: non-blocking: acceptance.md Contract gives no file:line for the boundaries it crosses (quality-checks.md asks for both sides). Add them with the AC-4 update.
Next: the lane's seat fixes the blocking findings; then a new review on the new head.

### 2026-11-05T04:33Z · kiro-exafy-202611050107-c4a6 · in-review → executing
Review changes on 45dcdf53 (entry above): fixing the blocking finding (gate jobs' non-success results posted as success).
