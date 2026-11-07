---
lane: rehearsal
state: done
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
updated: 2026-11-07T20:17Z
claimed_by: kiro-exafy-202611071602-6cfa
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

### 2026-11-06T22:31Z · agent-vitana-lane-reviewer-202611062231-b107 · review
review: accept
head: 6b14f77883ba38cfe3ef1e1da2161f0855465a0b
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4724
Findings: non-blocking: scripts/eng/rehearse.mjs:1214 has no explicit pin of AWS account, region or GitLab host; a wrong target is still refused before any write (secrets absent, GET /user identity check, live project profile check); an explicit pin is a suggested follow-up
Findings: non-blocking: scripts/eng/rehearse.mjs:657 check 10 passes: AWS reads only the agent token secrets and the two autoscaling Describe calls; four GitLab writes, all inside vitana/rehearsal and never on main; no GitHub or production call; control MRs and branches are closed and deleted, and all are named rehearsal/<run-id>/…
Findings: non-blocking: acceptance.md:53 A1-A4 and A8 are honestly marked as pending the owner's m2.sh rehearse (samples are a simulation; R1-R4 unchecked); A5-A7 and A9 are not claimed; plan §6 step 6 wording "A1-A8" is wider than what the tool decides
Findings: non-blocking: depends_on lanes all merged on main: #4679, #4697, #4711, #4716
Findings: non-blocking: red on base, red on stub and green on head are recorded; 235 of 235 mutations caught; no test weakened; no protected gate file touched; caller session not in the executing log
Next: the land step merges under §7b

### 2026-11-07T20:10Z · agent-vitana-lane-reviewer-202611072010-ae2b · review
review: accept
head: 1c73e6ed57b6ae938a001757dead585c9766da23
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4724
Findings: non-blocking: rehearse.mjs does not pin the AWS account (suggested hardening; AC-5 and AC-24 do not require it). Non-blocking: red on base is an import error (new test file); the substantive red is outputs/red-on-stub.txt and red-before-review-fixes.txt. Non-blocking: tasks.md R1 to R3 unchecked; R4 correctly pending. Non-blocking: A1 to A4 and A8 are pending the owner's live run; the evidence is a simulation against fakes. Non-blocking: headRefOid read from the worktree (matches 1c73e6ed57); nine CI runs read by id, all success.
Next: the land step merges under §7b

### 2026-11-07T20:12Z · kiro-exafy-202611071602-6cfa · in-review → verified
The reviewer-agent accept of 2026-11-07T20:10Z (agent-vitana-lane-reviewer-202611072010-ae2b, claude-sonnet-5.5, head 1c73e6ed57b6) is in this log. Checks on 1c73e6ed57: nine runs success.
Next: the land step merges under §7b.

### 2026-11-07T20:13Z · kiro-exafy-202611071602-6cfa · takeover
The plan driver of eng-gitlab-m2 took over this lane from kiro-exafy-202611021438-cff7 (the builder; its claim is stale). Its verified transition (4f609ac28f) was written before this takeover was logged, so this entry records it. Claim: refs/heads/collab-claim/eng-gitlab-m2/rehearsal held by kiro-exafy-202611071602-6cfa.

### 2026-11-07T20:17Z · kiro-exafy-202611071602-6cfa · verified → done
merge: b242f56f747fe51a7da3720420ba8e4bfce36f7e (PR https://github.com/exafyltd/vitana-platform/pull/4724, merged by land-guard merge under the §7b rule: review current on 1c73e6ed57b6 (agent-vitana-lane-reviewer-202611072010-ae2b, accept), nine check runs success, up to date with main).
authority: §7b PM rule. The lane's acceptance items A1 to A4 and A8 are pending the owner's live run (m2.sh rehearse); this closing record does not claim them.
Claim note: the claim refs/heads/collab-claim/eng-gitlab-m2/rehearsal is still held by kiro-exafy-202611062222-c262 (since 2026-11-06T22:38Z); it is released by the stale rule after 24 hours.
