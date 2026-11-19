---
lane: cutover
state: done
next_actor: kiro
depends_on: [pipelines, deploy-path, verify-on-gitlab, merge-queue, github-bridge, gateway-delivery]
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - infra/gitlab-engineering/settings/gitlab-settings.json
  - scripts/eng/gitlab-settings.mjs
  - scripts/eng/gitlab-settings-cutover.test.mjs
  - scripts/eng/delivery-cutover.sh
  - scripts/eng/delivery-cutover.test.mjs
  - scripts/eng/delivery-rollback.sh
  - scripts/eng/parity-report.mjs
  - scripts/eng/parity-report.test.mjs
  - scripts/eng/delivery-metrics.mjs
  - scripts/eng/delivery-metrics.test.mjs
  - scripts/eng/github-workflows.json
  - scripts/eng/github-workflows.test.mjs
  - infra/gitlab-engineering/RUNBOOK-cutover.md
  - .kiro/pipeline/driver.md
  - .kiro/pipeline/lane-land.md
  - docs/validation/**
updated: 2026-11-18T17:49Z
claimed_by: kiro-exafy-202611181602-02f5
branch: cutover-r2
pr: https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/60
vtid: VTID-05545
---
# Lane: cutover (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §8 (shadow, checklist, cut, rollback) and the measurement of §10. Starts when the other six lanes and eng-gitlab-m2 lane settings are done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T23:03Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.

### 2026-11-05T00:25Z · ci-plan-spar · ready (VTID allocated)
VTID-05545 allocated after policy approval (converged-auto-v1).
### 2026-11-05T02:53Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
### 2026-11-05T02:59Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)

### 2026-11-05T12:40Z · kiro-exafy-202611021438-cff7 · ready → executing
Claimed. Built on a stacked base (fleet, settings, merge-bot, monitoring) while those lanes were in review; rebuilt as one commit on origin/main after they merged. Tests first (103 cases on stand-ins for gh, aws, git and the GitLab machine). An independent pre-review found five blocking safety issues (B1 to B5); all fixed with tests red on the earlier code. Decisions taken inside the plan are in acceptance.md and the PR.

### 2026-11-05T23:01Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4725. Evidence from the final code: 103 cases green, 161 mutations all caught, the whole script set 1056 tests with 0 failures on Node 22 and Node 20, secret scan 0 matches. Ready for a review on the current head; depends_on lanes pipelines, deploy-path, merge-queue and gateway-delivery are not done yet, so it merges after them.

### 2026-11-06T22:31Z · agent-vitana-lane-reviewer-202611062231-d229 · review
review: accept
head: e827172e4c97b5dbb1d809d0d8262012edef94b2
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4725
Findings: non-blocking: the depends_on lanes (pipelines, deploy-path, merge-queue, gateway-delivery) are not done, so the merge waits for them under §7b.
non-blocking: the PR body and the C1 text in tasks.md say 159 workflows and 70 disable; the list, the test and acceptance.md say 160, 71 disable and 89 keep.
non-blocking: the base red run in red-on-base.txt used the earlier 14-item status test; the 15th item's red is covered by the B3 cases.
non-blocking: check 10 passes. apply is gated on the plan slug, a green checklist and the lock. status and the dry runs only read (tested). The rollback exists and is tested. Production is only read (GET of the kill switch) and AWS-PROD-* are never dispatched. No token is printed or stored. At run time step 4 disables PR-GATE.yml as plan §8.2 says.
Next: the land step merges under §7b once the depends_on lanes are done

### 2026-11-18T16:55Z · kiro-exafy-202611181602-02f5 · takeover: recovery branch cutover-r2 (lane stays in-review; new head needs a new review)
Owner execution order 2026-11-18: seat exafy rebuilds the lane on a clean recovery branch. Takeover of the stale exafy claim
(kiro-exafy-202611062222-c262, 2026-11-06) by a fast-forward of `collab-claim/agentic-delivery/cutover`; GitLab's `*` branch
protection refuses the delete that `queue.mjs release --stale` pushes. Not used: Kiro 1's `ce304758f7`
(hotmail seat, branch kiro1/agentic-delivery-cutover-counts, MR !58), left as it is.
- `cutover-r2` starts at 4ffe7bd26b and merges GitLab main d8b8a8c5e0 (4d507e28c8, no conflict).
- 663b5763cf: workflow list 170 = 123 platform + 47 vitana-v1 (pin bbe90b7137, vitana-v1 main today); 72 disable,
  97 keep, 1 replace. Kept: AWS-STAGE-PROVISION-DB, AWS-STAGE-CUTOVER-REHEARSAL, AWS-STAGE-CUTOVER, STAGING-MIGRATE,
  STAGING-DB-SCHEMA, GATE-INVARIANTS. New action `replace` for AWS-KIRO-ACCESS: the cut leaves it enabled until its GitLab
  replacement and the daily IAM drift check are verified. VTID-ALLOCATE.yml flagged protected. Status text, cutover
  test counts, RUNBOOK §6/§10 and AC-6 follow.
- Red on the merged base before the fix: github-workflows 7/11 pass (8 problems: 7 unclassified, VTID-ALLOCATE not
  protected), delivery-cutover 47/50 (files=47, 72 disables, runbook counts).
- Green: github-workflows 12/12 (with the vitana-v1 checkout and without), delivery-cutover 50/50,
  gitlab-settings-cutover 19/19, parity-report 14/14, delivery-metrics 9/9; UNIT 1747 tests, 1741 pass, 0 fail,
  6 skip (pglite, PyYAML, win32 only).

### 2026-11-18T17:05Z · kiro-exafy-202611181602-02f5 · update: MR !60 opened
MR https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/60 (short form vitana/vitana-platform#60; the earlier
GitHub PR exafyltd/vitana-platform#4725 is superseded). Head before this entry 41a3a8ec98. Preflight: Collab tests, Collab
handoff and Lane scope pass; PR-GATE scope (report-only) flags only this lane file. Next: reviewer agent on the MR head.

### 2026-11-18T17:20Z · agent-vitana-lane-reviewer-202611181714-cc36 · review
review: changes
head: 1b5b57478bc833d20c8fd730e96c76581e0d2163
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/60
Findings: blocking: docs/validation/VTID-05545 evidence (green.txt, red-on-base.txt, unit-all.txt, acceptance.md) still records 159/160 workflows and 1056 tests, and has no red/green for the 170 re-application on cutover-r2.
non-blocking: acceptance.md totals 160/71/89 vs 170/72/97/1 replace.
non-blocking: inventory classifications verified from the list; counts not recounted.
non-blocking: depends_on lanes must be done before merge; CI read by caller only.
non-blocking: no protected gate file touched; all files within paths.
Next: the lane's seat fixes the blocking finding (record the cutover-r2 red-on-base and green output in docs/validation/VTID-05545 and update acceptance.md)

### 2026-11-18T17:27Z · kiro-exafy-202611181602-02f5 · in-review → executing
Fixing the blocking finding of the review above. The cutover-r2 red, green and UNIT outputs go into docs/validation/VTID-05545/outputs/
(cutover-r2-red-on-base.txt, cutover-r2-green.txt, cutover-r2-unit-all.txt). acceptance.md gets a cutover-r2 section, and the stale
159/160 totals are marked superseded.

### 2026-11-18T17:31Z · kiro-exafy-202611181602-02f5 · executing → in-review
MR https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/60 (vitana/vitana-platform#60), with the evidence fix above.
deploy-path is done (MR !61, merge 1a38fc0619). Next: the reviewer agent on the new head.

### 2026-11-18T17:35Z · agent-vitana-lane-reviewer-202611181730-2f62 · review
review: accept
head: 3aee4367a92924291d2c906f315e3aa9bc514446
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/60
Findings: non-blocking: cutover-r2 red (github-workflows 7/11, delivery-cutover 47/50 on base 4d507e28c8) and green (12/12, 50/50, 19/19, 14/14, 9/9; UNIT 1747, 0 fail) are recorded; evidence is on 663b5763cf and no scripts/infra/pipeline file changed since.
non-blocking: inventory 123/47/170, VTID-ALLOCATE protected, six staging keeps, AWS-KIRO-ACCESS replace are test-asserted; JSON not recounted by hand.
non-blocking: all six depends_on lanes are done on origin/main 1a38fc0619.
non-blocking: head pipeline not read here; the caller confirms it before merging. No protected gate file touched; all files inside paths.
non-blocking: AWS-KIRO-ACCESS is disabled only after its GitLab replacement and daily IAM drift check are verified; outside this merge.
Next: the land step merges under §7b

### 2026-11-18T17:36Z · kiro-exafy-202611181602-02f5 · in-review → verified
Reviewer-agent accept above (claude-sonnet-5.5) on 3aee4367a92924291d2c906f315e3aa9bc514446. Since then only the review entry and this entry are added.
Every depends_on lane is done on GitLab main 1a38fc0619. Next: merge MR !60 under §7b once the head pipeline is green.
AWS-KIRO-ACCESS stays enabled until its GitLab replacement and the daily IAM drift check are verified.

### 2026-11-18T17:49Z · kiro-exafy-202611181602-02f5 · verified → done
merge: 51b879f38501fd5549ec466f54b6e2ba270db42e (GitLab MR !60 into main, pipeline green on the merged head, merged pinned to that head)
authority: §7b PM rule under the owner's execution order of 2026-11-18. The accept is on the reviewed head; the only changes after it are the review and state entries, plus main's own changes merged in.
