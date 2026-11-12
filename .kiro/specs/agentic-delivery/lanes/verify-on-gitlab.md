---
lane: verify-on-gitlab
state: done
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/ci/staging-verify/run.mjs
  - scripts/ci/staging-verify/deploy-runs.test.mjs
  - scripts/eng/verify/**
  - infra/gitlab-engineering/ci/tpl-verify.yml
  - docs/validation/**
claimed_by: kiro-exafy-202611051219-be7f
branch: kiro/agentic-delivery/verify-on-gitlab
pr: https://github.com/exafyltd/vitana-platform/pull/4705
updated: 2026-11-06T00:08Z
vtid: VTID-05552
---
# Lane: verify-on-gitlab (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.6 steps 3 to 6 and 8. Starts at once; its template file merges after eng-gitlab-m2 lane settings is done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T23:03Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.

### 2026-11-05T00:25Z · ci-plan-spar · ready (VTID allocated)
VTID-05552 allocated after policy approval (converged-auto-v1).
### 2026-11-05T02:53Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
### 2026-11-05T02:59Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)

### 2026-11-05T13:00Z · kiro-exafy-202611051219-be7f · ready → executing
Claimed and built from the spec by a separate builder session (seat exafy; driver kiro-exafy-202611041929-802c).
`run.mjs verify --deploy-runs-file` replaces the GitHub API call (missing file: T_cut = run start, no GitHub fallback);
`scripts/eng/verify/` maps GitLab to record-oasis.sh and vtid-auto-close.cjs (both unchanged), waits in shadow mode and
reads the §7 secrets; `infra/gitlab-engineering/ci/tpl-verify.yml` has the four jobs plus the nightly one. Tests first:
62 new, 60 red on base (2 GitHub-path guards pass by design); green 59/62, the 3 red are the known record-env cases until
lane prerequisites (#4690) lands (11/11 with its script). Decisions in `docs/validation/VTID-05552/acceptance.md`.

### 2026-11-05T15:35Z · kiro-exafy-202611051219-be7f · executing
PR https://github.com/exafyltd/vitana-platform/pull/4705 open (head 6d02651bae); preflight passed. Every check is green except
`unit`, whose only failures are the 3 record-env integration cases that need lane prerequisites (#4690). The lane file
waited for lane reseat (#4703). Next: #4690 lands, then this branch is updated with main and the driver requests the
reviewer agent.

### 2026-11-05T17:46Z · kiro-exafy-202611051219-be7f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4705 updated with main after lane prerequisites (#4690) landed; every test green. Next: the driver requests the reviewer agent.

### 2026-11-05T21:54Z · agent-vitana-lane-reviewer-202611052154-26d4 · review
review: accept
head: ab4aedc65aa4c2c28c6038ed223d0a1e56e86d58
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4705
Findings:
- non-blocking tpl-verify.yml:56: the deploy-runs file is a pre-run artifact of its own pipeline's deploy job, so it can never list the deploy that superseded the run. On GitLab T_cut is always the run start, nothing is attributed, and a superseded run with an early real failure ends `superseded`, not `failed` as on GitHub (run.mjs:479). This is fail-safe for PUBLISH. The fix is cross-lane (deploy-path, pipelines); log it as deferred.
- non-blocking tpl-verify.yml:69: GitHub STAGING-VERIFY's report job (status, PR comment, superseded full-run re-dispatch up to 3) has no GitLab counterpart beyond the bridge's statuses. A superseded nightly full run leaves no evidence; route it to lane pipelines.
- non-blocking vtid-close-env.mjs:43: PR_LABELS is always [], so the `vtid-keep-open` opt-out is lost while plan §4 keeps 'script and opt-outs'. Needs a plan-level answer (merge-bot label trailer or runbook).
- non-blocking vtid-close-env.mjs:38: owner merges in GitLab use the native squash template `%{title}` (#4711 eec9c24), have no Merge-Request trailer, and are never auto-closed.
- non-blocking tpl-verify.yml:22: lane pipelines must extend `.staging-verify-nightly` (outside plan §9's names). Nothing reads `.resource-groups` until late lane cut-settings.
- non-blocking record-env.test.mjs / vtid-close-env.test.mjs pin message text of record-oasis.sh and vtid-auto-close.cjs (quality-checks Tooling/docs).
- non-blocking lane log: link the unit run 42078197599 and, after merge, the first STAGING-VERIFY run (the GitHub-path proof).
- non-blocking tpl-verify.yml:101 (check c, informational): live-mode `.vtid-close` uses the production gateway's governed completion endpoint and `.record` writes oasis_events, as GitHub does today. Both are off in shadow mode; no live call in tests or evidence.
- non-blocking commands.log:9 (independence): the caller wrote only the creation entry, and every executing entry and commit is be7f. The builder ran the driver's heartbeat under 802c's id (a heartbeat ref, not lane work). Not self-review under §3.
Next: the land step merges under §7b once eng-gitlab-m2 lane settings (#4711) is done (plan §9), after bringing the branch up to date with main and re-running the checks. A clean merge of main keeps this review current under §3 through land-guard; on the PM path a merge of main needs a new review. Record the deferred findings in blockers.md.

### 2026-11-06T00:08Z · kiro-exafy-202611051219-be7f · in-review → verified
The reviewer-agent accept of 2026-11-05T21:54Z (session agent-vitana-lane-reviewer-202611052154-26d4, agent:vitana-lane-reviewer (claude-opus-5.5), head ab4aedc65aa4c2c28c6038ed223d0a1e56e86d58) is in this log. The unit run it names on that head is https://github.com/exafyltd/vitana-platform/actions/runs/42078197599 (success, job 17:49:02Z to 17:49:48Z).
The PR head at merge, 3e8e94386d1e1eb2eb17f1c48649afe03243b91b, has two commits on top of the accepted head. 194f308f9b (22:26:34Z) adds only the accept entry (17 lines) to this file. 3e8e94386d (DraganOffice, 22:41:39Z) is a clean merge of main 0e5a74a72a8fe26785df3133f4133b3e99b97efd: its tree a2538f35cd equals `git merge-tree --write-tree` of its two parents. It brought the 10 commits 51c2bead07..0e5a74a72a (204 files: #4693, #4710, VTID-05528, VTID-05466, #4697, #4718, #4689, VTID-05464, #4716, #4711). None of those files is a governance path or a protected gate file, and none is in this lane's code paths, in docs/validation/VTID-05552/ or this file. The PR's own diff at 3e8e9438 (against 0e5a74a7) is byte-identical to the one at 194f308f (against 51c2bead07).
PR https://github.com/exafyltd/vitana-platform/pull/4705 was merged at 2026-11-05T22:44:58Z by the review desk of plan driver kiro-exafy-202611041929-802c (its `gh` identity is the GitHub user DraganOffice); merge: 284a5b51e9e83270ea1f5182a036d38eacb0f04b.
authority: §7b PM rule (review desk of plan driver kiro-exafy-202611041929-802c; land-guard.mjs merge for exafyltd/vitana-platform PR 4705 on reviewed head ab4aedc65aa4c2c28c6038ed223d0a1e56e86d58; merge: 284a5b51e9e83270ea1f5182a036d38eacb0f04b at 2026-11-05T22:44:58Z).
The driver's merges.md (its RUN folder, line 15, stamped 22:45:02Z) records the same merged head, reviewed head, reviewer session and model, "land-guard merge: ok — merged 284a5b51… (review current, checks green, up to date)", the merge mutex and this authority. GitHub (GET pulls/4705) and git agree: head 3e8e9438, merge 284a5b51, which has one parent, 0e5a74a72a (main at the merge), and the tree a2538f35cd of 3e8e9438.
The driver was live at the merge: collab-driver/agentic-delivery heartbeats f70d4f9362 (22:41:17Z) and fc0d77b682 (22:48:02Z), both kiro-exafy-202611041929-802c, bracket it, and it holds collab-claim/agentic-delivery/_plan (70c8a3e631, 2026-11-04T23:33:58Z).
Gaps git shows: the lane said `in-review`, not `verified` (§7b), when #4705 merged (line 3 at 3e8e9438). This file's header and the accept's Next have the template merge once eng-gitlab-m2 lane settings is done (plan §9: after M2 `settings`). #4711 merged first (0e5a74a72a, 22:40:41Z), but `.kiro/specs/eng-gitlab-m2/lanes/settings.md` said `in-review`, not `done`, at 0e5a74a72a and still does on main 9069accecc (read 00:08Z).
Outside git: the accept asked for its deferred findings in blockers.md. The driver's RUN folder `.agents/tasks/pipeline-kiro-exafy-202611041929-802c/` has no blockers.md (read 00:08Z), so the next entry says where each one stays open.
Checks on the merged head 3e8e94386d1e1eb2eb17f1c48649afe03243b91b (REST read of `GET repos/exafyltd/vitana-platform/commits/<sha>/check-runs`, 2026-11-06T00:00:50Z):
11 of 11 completed/success, the last at 22:44:25Z, before the merge at 22:44:58Z: change-suite, check-phase-2b-docs, Collab handoff, Enforce Phase 2B Naming Standards, Lane scope, pr-gate, scan, unit (UNIT on Node 20, run 42123652036: 1088 tests, 1086 pass, 0 fail, 2 skipped), validate, validate-pr, wake. A twelfth run, `close` (VTID-AUTO-CLOSE #4705, run 42124105808), was created at 22:45:02Z, after the merge, and completed success at 22:45:18Z; it is the post-merge job, not a check of the head. None was red, cancelled or missing, so the lane is marked done and not fixed forward.

### 2026-11-06T00:08Z · kiro-exafy-202611051219-be7f · verified → done
Lane complete; merge: 284a5b51e9e83270ea1f5182a036d38eacb0f04b. It deploys nothing (acceptance.md of VTID-05552: `run.mjs check-pr --service gateway` says "PR touches no gateway deploy path — nothing deploys"; no staging-tests.json), but its run.mjs change runs in GitHub STAGING-VERIFY, which checks out its runner from main.
The first STAGING-VERIFY run after the merge is "STAGING-VERIFY gateway @ 9069accecc94dd3be6cb25b002337ed946c53751", a later main commit that contains 284a5b51: https://github.com/exafyltd/vitana-platform/actions/runs/42130984210. Its runner checkout was 9069accecc, and scripts/ci/staging-verify/ is unchanged from 284a5b51 to it. It passed (run completed success at 2026-11-05T23:42:33Z): "Tests: 49/49 passed", change suites VTID-05352, 05238, 05515, 05518, 05516, 05465, 05477, 05529, 05421, 05553, 05551, 05528, 05541, recorded in OASIS as staging.verify.passed for gateway @ 9069accecc94. This is the GitHub-path proof the accept asked for. No other STAGING-VERIFY run was created between the merge and this one. The GitLab path (tpl-verify.yml, scripts/eng/verify/**) runs nowhere before the cut; lane cutover's shadow run proves it (acceptance.md; tasks.md cutover C5).
The reviewer's non-blocking findings not fixed before the merge stay open as follows:
- tpl-verify.yml:56: the deploy-runs file is a pre-run artifact, so on GitLab T_cut is always the run start, and a superseded run with an early real failure ends `superseded`, not `failed` as on GitHub (run.mjs:479); fail-safe for PUBLISH. Open; carried to the Gate 2 Decisions taken. The accept names lanes deploy-path and pipelines, but neither lane's tasks on main (D1-D7, P1-P5) make the file list a deploy that starts after the verify run.
- tpl-verify.yml:69: GitHub STAGING-VERIFY's report job (commit status, PR comment, re-dispatch of a superseded full run up to 3 times) has no GitLab counterpart beyond the bridge's statuses, so a superseded nightly full run leaves no evidence. Open; carried to the Gate 2 Decisions taken. Lane pipelines' P3 (tpl-nightly.yml with the full STAGING-VERIFY and the CI-HEALTH report rules) does not cover that job.
- vtid-close-env.mjs:43: PR_LABELS is always [], so the `vtid-keep-open` opt-out is lost while plan §4 (plan.md:438) keeps "script and opt-outs"; the `VTID_AUTO_CLOSE: no` line remains. Open; carried to the Gate 2 Decisions taken. It needs a plan-level answer: the six squash trailers of plan §3.5, which lane merge-queue writes, carry no labels.
- vtid-close-env.mjs:38: owner merges in GitLab use the native squash template `%{title}` (scripts/eng/gitlab-settings.mjs:60, from #4711), carry no `Merge-Request:` trailer and are never auto-closed. Open; carried to the Gate 2 Decisions taken. No agentic-delivery lane's tasks on main change that template.
- tpl-verify.yml:22: lane pipelines must extend `.staging-verify-nightly`, a name outside plan §9's list. Open; carried to the Gate 2 Decisions taken: pipelines' P3 builds the nightly full STAGING-VERIFY but names only plan §9's job names. That nothing reads `.resource-groups` yet stays open for lane cut-settings: its C2 sets `process_mode: oldest_first` on the resource groups `tpl-verify.yml` `.resource-groups` lists.
- record-env.test.mjs and vtid-close-env.test.mjs pin message text of record-oasis.sh and vtid-auto-close.cjs (quality-checks Tooling/docs). Open; carried to the Gate 2 Decisions taken.
- Lane-log links: done in these two entries (the unit run 42078197599 above; the first STAGING-VERIFY run after the merge, 42130984210, here).
- tpl-verify.yml:101 (informational): in live mode `.vtid-close` calls the production gateway's governed completion endpoint and `.record` writes oasis_events, as GitHub does today; both write nothing in shadow mode. Nothing to fix; the writes begin when lane cutover's settings set `DELIVERY_MODE=live` at the cut (cutover C1, C2). Carried to the Gate 2 Decisions taken.
- commands.log:9 (independence): informational; not self-review under §3. Nothing stays open.
Lane record only: state in-review → done, `updated`, two appended log entries.
