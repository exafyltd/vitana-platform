---
lane: github-bridge
state: done
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
updated: 2026-11-06T00:13Z
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

### 2026-11-05T16:48Z · kiro-exafy-202611050107-c4a6 · in-review → executing
Review changes on bd9cd43d (entry above): fixing the two blocking findings.

### 2026-11-05T17:06Z · kiro-exafy-202611050107-c4a6 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4689 updated (fix round 2); validate-pr-locally APPROVED; preflight passed. Next: the driver requests a new review.
Both blocking findings fixed (acceptance.md "Review round 2"): AC-4 split into AC-4, AC-14, AC-15, AC-16, every AC with its TEST line within 9 lines; no success is posted before a non-success result of any job (collab-handoff test).
Non-blocking done: gitlab/gate pending until all three gate jobs have a result; landing comment and close in the one write budget; `Moved from <PR URL>` line (plan §3.11).
Red on the bd9cd43d code: 58 tests, 53 pass, 5 fail; green 58/58; UNIT 705 tests, 0 fail; mutations 32/32 caught; origin/main merged (193a5ff9).

### 2026-11-05T17:34Z · agent-vitana-lane-reviewer-202611051734-fa1b · review
review: accept
head: 4b59a16f2e0e91709e096d4a48ad6798e49aa1c4
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4689
Findings: non-blocking: scripts/eng/github-bridge.mjs:963. The pending gitlab/gate depends only on lane-scope, change-suite and gate. Once those three have results, a job that is still running gets no pending status (collab-handoff, required on vitana-platform per plan.md:213-215, or any job gate does not need). GitHub then shows only success, while the merge bot reads any running job as pending (eng-gitlab-m2 plan.md:135-139, :151). The comment at :958-959 and RUNBOOK-github-bridge.md:185-186 say this never happens. The gap lasts until that job has a result, which is then posted before every success; landing and plan-driver.mjs (acts only on failed) are not affected. Option: keep gitlab/gate pending until the head pipeline has ended, with a test, or correct both claims.
Findings: non-blocking: checked, no action needed: both blocking findings of 16:05Z are fixed. validate-pr is green on this head. statusTier (:135-136, sort :1008) posts no success before a non-success; the collab-handoff test failed on the bd9cd43d code and passes now. The pending gate until all three gate jobs have a result (:948-965), the landing writes in the one budget (:900-915, :1013-1026) and the Moved from line (:149-159) each have a test that failed on bd9cd43d. Red 53 of 58 pass, green 58 of 58, UNIT 705 tests with 0 failures, mutations 32 of 32 caught. The changed fixture in 'the status budget goes first…' does not weaken the test: no assertion was removed, and its old all-red case is the new test 'every non-success job result goes before any success…'. The Contract's file:line references match this head.
Findings: non-blocking: github-bridge.mjs:149. The Moved from line is inside the converged plan: plan.md:367 takes scm.migration.pr_moved from the description line 'Moved from <PR URL>'. No lane tests the reader yet (gateway-delivery G1, tasks.md:248-253, lists the cutover tags but not pr_moved). The driver should give that lane the exact shape: the last line of the description, 'Moved from https://github.com/<owner>/<name>/pull/<n>'.
Findings: non-blocking: I could not read CI here (gh pr view and gh pr checks need GraphQL; gh api is not an allowed command). Per the caller's REST read at 17:31:35Z, every check on 4b59a16f finished with success, unit (UNIT.yml, Node 20) included, and each cancelled run is a superseded duplicate with a success run of the same name. land-guard.mjs checks printed 'ok — 12 checks green' at 17:33Z. The evidence links no CI run for this head. The head is 2 commits behind origin/main (#4642, #4635: other plans' specs and docs/programs/native-app/program.md only).
Findings: non-blocking: independence and order. The caller kiro-exafy-202611041929-802c appears only in the 23:03Z creation entry and is the Collab-Session of no branch commit; its commits 137d38dc and c88bc85c carry the reviewer sessions. The builder again sent the driver's heartbeats under that id (commands.log F8, R8). So the self-review rule does not apply. gitlab-client's code (#4679, 8f3934c8) is an ancestor of this head and landed before this lane started; its lane file on main still says in-review until #4693 lands.
Findings: non-blocking: the items under 'Open items for the driver' in acceptance.md are still open and outside this lane's paths: the timer stays disabled until the cut (M2's ops-install.sh is not on main yet); no gitlab/* status for a refused branch or a new head without a pipeline; plan §2.2 and §8.1 step 4 against §3.13; the bridge's GitLab account; M2's pushed-by-agent-reviewer check; the caller of assist-push; PLAN-SPAR's result on GitLab; the §8.1 step 4 run on a GitLab instance.
Next: the land step merges under §7b (land-guard.mjs merge: up to date with origin/main and every check green on that head).

### 2026-11-06T00:13Z · kiro-exafy-202611050107-c4a6 · in-review → verified
The reviewer-agent accept of 2026-11-05T17:34Z (session agent-vitana-lane-reviewer-202611051734-fa1b, agent:vitana-lane-reviewer (claude-opus-5.5), head 4b59a16f2e0e91709e096d4a48ad6798e49aa1c4) is in this log.
The PR head at merge, c2ea6754777fc96f433757bbb03f6ce4bed5d581, adds six commits to the accepted head. d7473f2c56 (17:59:11Z, Collab-Session of that reviewer, Collab-Reviewed-Head 4b59a16f) adds only the 13-line accept entry to this file.
The other five are DraganOffice's update merges of `main` (committer GitHub): 942a15c455 (17:59:40Z, main 51c2bead07: #4642, #4635, #4690), c9ca3c03f9 (18:05:45Z, f04ef19f4b: #4693), 57fa41b3e0 (18:12:34Z, 9f239e17db: #4710), 04cf7f8295 (21:48:08Z, 72dbefbaae: ec7f45ccb7 VTID-05528, 27de7a98d1 VTID-05466, #4697) and c2ea675477 (21:50:17Z, d73fec53f9: #4718).
Each is a clean merge of main (collaboration.md §3, land-guard.mjs:49-55): its second parent is on origin/main, its tree equals `git merge-tree --write-tree` of its two parents, and none of the 154 files the five bring in is a governance path (queue.mjs:86-87) or a protected gate file. The PR's own 20 files are byte-identical at d7473f2c56 and c2ea6754.
PR https://github.com/exafyltd/vitana-platform/pull/4689 was merged at 2026-11-05T21:55:22Z by the review desk of plan driver kiro-exafy-202611041929-802c (its `gh` identity is the GitHub user DraganOffice); merge: 0f45367bb69a8661eca6d5170ebb33909d03d001.
This session (the lane's builder) did not merge it. The land-guard result is from the driver's RUN file `.agents/tasks/pipeline-kiro-exafy-202611041929-802c/merges.md` (local state, not in git; line written 21:55:25Z): "land-guard merge: ok — merged 0f45367bb69a8661eca6d5170ebb33909d03d001 (review current, checks green, up to date); merge mutex held; deploys nothing". `gh api user` in this sandbox, where that RUN folder is, returns DraganOffice.
authority: §7b PM rule (review desk of plan driver kiro-exafy-202611041929-802c; land-guard.mjs merge for exafyltd/vitana-platform PR 4689 on reviewed head 4b59a16f2e0e91709e096d4a48ad6798e49aa1c4; merge: 0f45367bb69a8661eca6d5170ebb33909d03d001 at 2026-11-05T21:55:22Z).
Git agrees: 0f45367b is a one-parent squash with tree 530439c26f, the tree of c2ea6754; its parent d73fec53f9 was main at the merge and is the second parent of c2ea6754, so the PR was up to date.
The collab-driver/agentic-delivery heartbeats that bracket the merge are 90dff12e (21:55:04Z, the tree of d73fec53) and 8a550cd4 (21:57:23Z, the tree of 0f45367b), both with Collab-Session kiro-exafy-202611041929-802c. The plan's builders also write heartbeats under that id; the RUN file heartbeats.log records the one before them, 17f8aa47 (21:54:49Z), as written by `desk3-lander`. The _plan claim (collab-claim/agentic-delivery/_plan, 70c8a3e6) is held by kiro-exafy-202611041929-802c since 2026-11-04T23:33:58Z.
Gaps git shows: the lane said `in-review`, not `verified` (§7b), when #4689 merged (line 3 at c2ea6754 and at 0f45367b); and no `merge:` or `authority:` line was written to this log at the merge (driver.md Loop step 6, common-rules.md rule 4), so this entry records both from merges.md.
Checks on the merged head c2ea6754777fc96f433757bbb03f6ce4bed5d581 (REST read of `GET repos/exafyltd/vitana-platform/commits/c2ea6754777fc96f433757bbb03f6ce4bed5d581/check-runs`, 2026-11-06T00:00:52Z, and again with `filter=all` at 00:08:56Z):
11 of 11 completed/success, the last at 21:54:24Z, before the merge at 21:55:22Z: change-suite, check-phase-2b-docs, Collab handoff, Enforce Phase 2B Naming Standards, Lane scope, pr-gate, scan, unit (UNIT.yml on Node 20.20.2, run 42116241983: 882 tests, 880 pass, 0 fail, 2 skipped), validate, validate-pr, wake.
A twelfth run, `close` (VTID-AUTO-CLOSE, run 42116979330), started at 21:55:29Z, after the merge, and completed success at 21:55:43Z; it is the post-merge job, not a check of the head. No run on this head was cancelled. The head has no commit status, and the check suites of five other apps (vercel, google-cloud-build, claude, supabase, kiro-agent) stay `queued` with no check run.
Every check-run name of the accepted head 4b59a16f is here except `sql`. Its three `sql` runs were push runs of SQL-MEMORY-FUNCTIONS-MIGRATE-REVOKE, SQL-TENANT-FOUNDATION and SQL-WEARABLE-SAMPLES-RPC-REVOKE, started by the push of 4b59a16f, which carried the branch's merge of main 193a5ff9 that changed those three workflow files. Their path filters match none of the PR's files, and the push of c2ea6754 changed only seven spec files. None was red or missing, so the lane is marked done and not fixed forward.

### 2026-11-06T00:13Z · kiro-exafy-202611050107-c4a6 · verified → done
Lane complete; merge: 0f45367bb69a8661eca6d5170ebb33909d03d001. It deploys nothing, so no staging proof applies (acceptance.md of VTID-05548, lines 159-162). GitHub has no deploy or STAGING-VERIFY run on 0f45367b: its runs are TEST-CATALOG, Dev Autopilot Impact Scan, PHASE-2B-NAMING-ENFORCEMENT and CODEINTEL-INDEX (push) and one scheduled alert, all success.
The reviewer's non-blocking findings not fixed before the merge stay open as follows (the six findings of the 17:34Z accept, in its order; the non-blocking items of the 03:42Z and 16:05Z reviews that are still open on main are inside the first, third and sixth):
- Pending gate (github-bridge.mjs:963): once lane-scope, change-suite and gate have results, a job that still runs (collab-handoff, or any job gate does not need) gets no pending status, so GitHub can show only success; the comment at github-bridge.mjs:958-959 and RUNBOOK-github-bridge.md:185-186 say this never happens. No later lane's tasks change these files: open; carried to the Gate 2 Decisions taken.
- Checked, no action needed (both 16:05Z blocking findings fixed, the new tests, red and green, mutations, the changed fixture, the Contract): nothing stays open.
- The `Moved from` line (github-bridge.mjs:149-159) has no tested reader: plan.md:367 takes `scm.migration.pr_moved` from it, and gateway-delivery G1 (tasks.md:248-252) names `scm.migration.cutover` (from the tags `delivery/cutover-<repo>`) but not `scm.migration.pr_moved`. Open; carried to the Gate 2 Decisions taken, with the shape that lane needs: the last line of the description, `Moved from https://github.com/<owner>/<name>/pull/<n>`.
- CI not read in the review: answered by the check runs of the merged head in the entry above; nothing stays open.
- Independence and order: no action; gitlab-client is `done` on main since #4693 (f04ef19f4b, 2026-11-05T18:04:33Z), before this merge; nothing stays open.
- The open items for the driver in acceptance.md:313-331, outside this lane's paths:
  - Timer disabled until the cut (acceptance.md:324-327): open; carried to the Gate 2 Decisions taken. Since #4711 (0e5a74a72a, 2026-11-05T22:40:38Z, after this merge), main's ops-install.sh enables and starts every timer in host/units (`enable_timers`, ops-install.sh:220-236, called at :248; `m2.sh install` runs the script), vitana-github-bridge.timer included, so RUNBOOK-github-bridge.md:88-89 ("installed but not enabled") stops holding once `m2.sh install` runs. Until both token files exist, the service's `AssertPathExists` (vitana-github-bridge.service:14-15) keeps the bridge from running. No later lane's tasks pin "install, do not enable": cut-settings changes only gitlab-settings.mjs and gitlab-settings.json (tasks.md:441), and cutover's `apply` runs the steps of plan §8.2 (tasks.md:305-307), whose step 5 starts the bridge at the cut (plan.md:588).
  - No `gitlab/*` status for a refused branch's pull request or for a new head without a pipeline (acceptance.md:328-331, RUNBOOK-github-bridge.md:192-194), which plan-driver.mjs:195-200 reads as green: open; carried to the Gate 2 Decisions taken.
  - Plan §2.2 (the kept workflows' pull requests, on branches `whats-new/*` and `i18n-db/artifacts`, go through the bridge) against §3.13 (only `kiro/*` and `claude/*`), acceptance.md:314-316: open; carried to the Gate 2 Decisions taken.
  - The bridge's GitLab account and its token file (acceptance.md:317): lane `cut-settings`, task C2, creates the account (Developer on both projects; scopes api, write_repository) and writes /etc/vitana/gitlab-bridge-token (tasks.md:437-439).
  - Bridged pushes reach GitLab as the bridge's account, so M2's check that the accept was pushed by `agent-reviewer` (gitlab-land.mjs:146, :249-254) fails for a bridged same-repo lane (acceptance.md:318-319). Lane `merge-queue` adds a review source that reads accepts from lane logs (tasks.md:181-183, :196-198), but its tasks do not name the bridged pusher: open; carried to the Gate 2 Decisions taken.
  - The caller of `assist-push` and the ref the assist job writes (acceptance.md:323): the ref is lane `merge-queue`'s (`assist/<iid>-<rule>`, tasks.md:187, :196-198), and lane `cut-settings` lets `bot-land` push `assist/*` (tasks.md:437); no lane's tasks name the caller of `assist-push`: open; carried to the Gate 2 Decisions taken.
  - PLAN-SPAR's result on GitLab (acceptance.md:320): lane `merge-queue`, task Q1: a `plan(` merge request lands only with a successful `gitlab/plan-spar` or GitHub PLAN-SPAR status on its head (tasks.md:193-194).
  - The plan §8.1 step 4 run on a GitLab instance (acceptance.md:321-322): no lane's tasks run it; lane `cutover`'s `delivery-cutover.sh status` prints it among the §8.1 checklist items and `apply` refuses while one is not green (tasks.md:305-306, :328): open; carried to the Gate 2 Decisions taken.
Lane record only: state in-review → done, `updated`, two appended log entries.
