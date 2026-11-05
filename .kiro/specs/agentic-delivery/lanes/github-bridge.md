---
lane: github-bridge
state: in-review
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
updated: 2026-11-05T05:14Z
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
### 2026-11-05T02:53Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
### 2026-11-05T02:59Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)

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

### 2026-11-05T05:14Z · kiro-exafy-202611050107-c4a6 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4689 updated (fix round 1); preflight passed. Next: the driver requests a new review.

### 2026-11-05T16:05Z · agent-vitana-lane-reviewer-202611051546-fbe4 · review
review: changes
head: bd9cd43d2dde67dddab2420df10c69d667b85176
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4689
Findings: blocking: CI is red on bd9cd43d. validate-pr (VALIDATOR-CHECK.yml 'Acceptance Mapping Gate', run 42057212580) exits 41 with 'AC at line 33 has no TEST:/CURL:/UI: mapping within 12 lines'. Fix round 1 grew AC-4 to acceptance.md:33-50, which put its TEST: line (:51) outside the 12-line window; it passed on 45dcdf53. land-guard checksVerdict refuses this check, and it is a real red, not the rule 4 false positive. Fix: shorten or split AC-4 so every AC- line has a TEST: line within 12 lines, and run the gate's check before pushing.
Findings: blocking: scripts/eng/github-bridge.mjs:130 sorts every job other than lane-scope, change-suite and gate after the gate successes (:976). A pipeline can be red through such a job while all three gate jobs pass: collab-handoff is required on vitana-platform (plan.md:213-215), gate needs only the checks (:223-224), and the merge bot fails any failed job (eng-gitlab-m2 plan.md:135-139). With a budget of 1, GitHub then shows only a gate success for a merge request that cannot land. At the plan §5 load (about 190 pipelines an hour, up to 4 gate-group writes each, against 450 an hour), the failure can wait as long as the load lasts, and plan-driver.mjs:195-200 reads that as green. AC-4 (acceptance.md:47-48) and the runbook (:177-179) say this never happens. Fix: post no success before a non-success (non-success gate, other non-success, gate success, other success), and add a test recorded red on bd9cd43d (collab-handoff failed, gate success, budget 1: the one status posted is non-success).
Findings: non-blocking: github-bridge.mjs:934 adds the pending gate only while gate has no result. In a docs-only or lane-file-only merge request (tasks.md:78-79), all of gate's needs are optional and absent, so GitLab starts gate at once (needs:optional). Gate can pass while lane-scope and change-suite still run, and GitHub shows only success for about one tick. Landing is not affected. Option: keep gitlab/gate pending until all three gate jobs have a result, with a test.
Findings: non-blocking: GitHub content limits: the landing comment (:889) and the PR close (:891) do not count against the status budget of 60 a tick and 450 an hour. At the plan §5 landing rate (about 40 an hour per repository), the account can pass GitHub's limit of about 500 content writes an hour. The tested rate-limit pause catches this; one budget for every GitHub write would keep the bridge under the limit.
Findings: non-blocking: plan.md:367 takes scm.migration.pr_moved from a merge request description line 'Moved from <PR URL>'. The bridge copies the body unchanged (mrDescription :140, as B1 and §3.13 ask), and no lane writes or reads that line. The driver decides: either the bridge appends the line, or §3.11 takes the event from another source.
Findings: non-blocking: some 03:42Z items stay open, recorded in acceptance.md 'Open items for the driver' and rightly not changed here: timer disabled until the cut; no gitlab/* status for a refused branch's PR or for a new head without a pipeline; plan §2.2/§8.1 step 4 against §3.13; the bridge's GitLab account; M2's pushed-by-agent-reviewer check; the caller of assist-push; the §8.1 step 4 run needs a GitLab instance.
Findings: non-blocking: independence: the builder sent the driver's heartbeats as kiro-exafy-202611041929-802c (commands.log:11, :128-129). The caller appears in the lane log only in the 23:03Z creation entry, and its one branch commit (137d38dc) carries the reviewer's session, so the self-review rule does not apply.
Findings: non-blocking: checked, no action needed: the merge bd9cd43d resolved the lane file correctly (branch front matter, seat exafy as on main after #4703; main's four log entries unchanged and in order, then the branch's five entries once each). The PR's other 18 files are byte-identical at 83f8b616 and bd9cd43d. Fix round 1's gate mapping (github-bridge.mjs:101-124) is correct and tested: red on 137d38dc with 7 of 54 failing, green 54 of 54, mutations 25 of 25. The Contract now gives file:line on both sides.
Next: the lane's seat fixes the two blocking findings and merges current main (a8220f10 and b5544e37 landed after 49cff4a9); the driver then requests a new review on the new head.
