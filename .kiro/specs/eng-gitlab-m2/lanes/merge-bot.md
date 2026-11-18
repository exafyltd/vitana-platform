---
lane: merge-bot
state: done
next_actor: kiro
depends_on: [gitlab-client]
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/eng/gitlab-land.mjs
  - scripts/eng/gitlab-land.test.mjs
  - infra/gitlab-engineering/host/units/vitana-land.service
  - infra/gitlab-engineering/host/units/vitana-land.timer
  - docs/validation/**
updated: 2026-11-06T22:44Z
claimed_by: kiro-exafy-202611062222-c262
branch: kiro/eng-gitlab-m2/merge-bot
pr: https://github.com/exafyltd/vitana-platform/pull/4697
vtid: VTID-05538
---
# Lane: merge-bot (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.4. Imports the land-guard.mjs and queue.mjs functions; edits neither. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-03T19:40Z · kiro-exafy-202611021438-cff7 · ready
Lane created with the plan.

### 2026-11-04T19:35Z · ci-plan-spar · ready (VTID allocated)
VTID-05538 allocated after policy approval (converged-auto-v1).

### 2026-11-05T10:59Z · kiro-exafy-202611021438-cff7 · ready → executing
Claimed; test, module, units and evidence on branch kiro/eng-gitlab-m2/merge-bot. Tests first (red on base: the module cannot be imported; red on a
stub: 54 of 54 cases fail on their own), then `scripts/eng/gitlab-land.mjs` and the two units. `lane gitlab-client` is merged (8f3934c8bed, closing
record in plan PR #4693), so its client and fake fetch are the ones used here. The requirement carried from that lane is met: `PUT …/merge` with
`retries: 0` and a re-read of the merge request after an error. Decisions taken inside the plan (listed for Gate 2): the review is the newest review of
the lane (a `changes` after an accept withdraws it); a branch behind a main that brought in a governance or protected gate file is left alone with one
comment, because the merge would end the review; a behind branch with a pending pipeline waits, as `mergeDecision` orders its gates.

### 2026-11-05T11:09Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4697. Evidence regenerated from the final code: 54 cases (red on base, red on a stub 54 of 54, green 54 of 54), a
mutation run of 98 changes (0 not caught), the whole script set 667 tests with 0 failures on Node 22 and Node 20, the 24-row table against `mergeDecision`, a dry-run
transcript, `land-guard.mjs` and `queue.mjs` untouched. Ready for a review on the current head; the lane's `depends_on` lane `gitlab-client` is merged and its closing
record is PR #4693.

### 2026-11-05T14:13Z · agent-vitana-lane-reviewer-202611051413-7217 · review
review: changes
head: 570fe18b55450e3a37e2ea4cfe1e883fd0acb7a8
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4697
Findings: blocking: scripts/eng/gitlab-land.mjs:399: when a behind merge request's merge of main conflicts, acted is still set to true every tick (conflict path at lines 342-346, break at line 378). No younger merge request of the project is then evaluated, updated or landed until the builder resolves the conflict. Plan §3.4 says a merge request that needs a human is skipped, not waited for. This is untested: the conflict test at gitlab-land.test.mjs:668 has one merge request. Treat a conflict as a skip with its one comment, and add a two-merge-request test (older one conflicts, younger one lands) and its mutation.
Findings: non-blocking: gitlab-land.mjs:330 and 400: a merge GitLab keeps refusing (unresolved threads; a red bridge job or a pipeline status the bot does not read) also holds the turn every tick with no limit. This is inside plan §3.4 ("retried at the next tick"); consider the 60-minute bound, and failing closed on a finished pipeline whose status is not success.
Findings: non-blocking: gitlab-land.mjs:230: a reviewer push without commit_from (a branch the reviewer account created) is widened to commit_count commits, which for a new branch can include builder commits and a forged accept. The planned flow does not reach this; count only commit_to there.
Findings: non-blocking: gitlab-land.mjs:237 (eventPages 5): only the newest 500 push events are read. On a busy project a real accept ages out and is refused as not pushed by the reviewer. This fails closed.
Findings: non-blocking: gitlab-land.mjs:89 and 442: a landing project with no or a misspelled required_jobs lands on checksVerdict alone, where skipped and neutral jobs pass. This follows the plan's wording; consider refusing to land.
Findings: non-blocking: vitana-land.service:12 runs as root with no User= or sandboxing while running git on agent branches, and gitlab-land.mjs:457 does not neutralise a global credential.helper that could store the token. Hardening only; the plan asks for flock, Nice, CPUQuota and MemoryMax.
Findings: non-blocking: outputs/untouched-guard-files.txt:8-14 lists VTID-05479 and mt-identity-r2 files as this lane's (a two-dot diff against a stale origin/main). commands.log:2 names base 29b639da4bf and red-on-base.txt:1 names base e47da4cebb6. The PR diff holds only lane paths.
Findings: non-blocking: this review did not re-read CI on 570fe18 (the gh pr commands need GraphQL here, and gh api is not allowed). The 11 green check runs are the caller's REST read at 14:05Z.
Findings: non-blocking: the branch is 3 commits behind main, and abe2d7a59f (VTID-05331) changes scripts/collab/queue.mjs and queue.test.mjs, so a review will not carry across the land step's merge of main (mergeKeepsReview). Merge main with the fix and request the next review on that head.
Next: the lane's seat fixes the blocking findings

### 2026-11-05T16:20Z · kiro-exafy-202611021438-cff7 · in-review → executing
The review of 2026-11-05T14:13Z (head 570fe18b55450e3a37e2ea4cfe1e883fd0acb7a8) is `changes`. One answer per finding:
- [blocking] a conflict of the merge of `main` holds the turn (gitlab-land.mjs:342-346, :378, :399): accepted. A conflict is now a skip, like any merge
  request that needs a human (plan §3.4): `acted` stays false, the younger merge requests of the project are evaluated in the same tick, and the one comment
  per head and reason is kept. The old conflict case now expects the skip; a new two-merge-request case (the older conflicts, the younger one lands in the
  same tick, the conflict is not commented twice) and its mutations are added, recorded red on the code as reviewed.
- [non-blocking] a merge GitLab keeps refusing holds the turn every tick (:330, :400): accepted for the 60-minute bound, in the form the bot already uses for
  a pending pipeline (counted from the pipeline's `created_at`, from the merge request's `updated_at` without a pipeline): a refused merge keeps the turn
  while that time is under 60 minutes and loses it after that, so the merge requests behind it are served. It needs no state between ticks. A dry run makes
  no merge call and so never counts as a refusal. Test and two mutations. The second half (fail closed on a finished pipeline whose own status is not
  `success`) is deferred to lane `merge-queue` of plan agentic-delivery, which edits this file next: plan §3.4 defines the checks as the jobs of the pipeline,
  the pipeline's own status and its bridge jobs are outside that definition, and the new bound already limits the cost of such a refusal to 60 minutes.
- [non-blocking] a reviewer push without `commit_from` is widened to `commit_count` commits (:230): accepted. Such a push now proves its tip only
  (`commit_to`), so builder commits and a forged accept below the tip are never counted. Test (with the control that an accept which IS the tip still counts)
  and a mutation.
- [non-blocking] only the newest 500 push events are read, `eventPages` 5 (:237): deferred to lane `merge-queue` of plan agentic-delivery (it edits this file
  next and moves the review source). It fails closed: an accept that has aged out is refused, never landed.
- [non-blocking] a landing project with no or a misspelled `required_jobs` (:89, :442): rejected. The bot follows plan §3.4 ("every name in the project's
  `required_jobs` must be present and map to `success`"), and a misspelled name already fails closed in the bot (a required name that is absent from a finished
  pipeline is `required_job_missing`). What the list should contain for each landing project is owned by lane `settings` (plan §3.3, `gitlab-settings.json`);
  its sync is where the file is checked, not this bot.
- [non-blocking] the unit runs as root and a global `credential.helper` is not neutralised (service:12, :457): the credential part is accepted. Every git
  command the bot runs now starts with `-c credential.helper=` (an empty value clears any configured helper), so a global helper cannot store the token that
  `GIT_ASKPASS` gives git. Test (a recording `git` in front of the real one sees every command carry the flag; a control shows the flag stops a global `store`
  helper from writing a credential) and two mutations. The `User=` / sandboxing part is deferred to lane `settings`, which creates the accounts and the token
  file (plan §3.3: `/etc/vitana/bot-land-token`, mode 0600) and installs the units; plan §3.4 asks this unit for `flock`, `Nice`, `CPUQuota` and `MemoryMax`.
- [non-blocking] `outputs/untouched-guard-files.txt` listed files of other lanes, and `commands.log` / `red-on-base.txt` named different bases: accepted. The
  list is now a three-dot diff against a freshly fetched `origin/main`, and one base is named in `commands.log`, `red-on-base.txt` and the list.
- [non-blocking] CI was not re-read by the reviewer: nothing to change. The check runs of the new head are read by REST after the push.
- [non-blocking] the branch is behind `main` (abe2d7a59f changes `queue.mjs`): accepted. `origin/main` is merged into the branch after the fix, and all evidence
  is regenerated from the final code on the merged head; the next review is asked on that head.

### 2026-11-05T16:38Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4697. The review of 2026-11-05T14:13Z is answered in the entry above; `origin/main` (b3d547b66c7) is merged into the
branch. Evidence regenerated from the final code on the merged head: 58 cases (red on base 1 of 1, red on a stub 58 of 58, red on the code as reviewed 6 of 58, green 58 of 58),
a mutation run of 115 changes (0 not caught), the whole script set 705 tests with 0 failures on Node 22 and Node 20, the 24-row table against `mergeDecision` (0 differences),
`land-guard.mjs` and `queue.mjs` untouched, a secret scan of 22 files. Deferred, with where: the pipeline-status half of finding 2 and `eventPages` to lane `merge-queue`;
`User=` and sandboxing of the unit to lane `settings`. Ready for a new review on the current head.

### 2026-11-05T17:07Z · agent-vitana-lane-reviewer-202611051707-cc3b · review
review: accept
head: 363560d80e7428f61728e6fc91f27a51f30940e8
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4697
Findings: non-blocking: .kiro/specs/eng-gitlab-m2/lanes/gitlab-client.md:3: §7b preconditions for the land step, not code issues. Lane gitlab-client (depends_on) is still state: in-review on origin/main, because its closing record PR #4693 is not merged. The branch is 3 commits behind origin/main 5381e3e146 (cd1e8e306b, 2b7a6ee99e, 5381e3e146). Those commits hold other plans' .kiro/specs files and docs/programs/native-app and standalone program.md, with no governance path or protected gate file, so a clean merge of main keeps this review under land-guard.mjs merge --repo. Merge only after #4693 is on main, with the branch updated and re-checked on that head.
Findings: non-blocking: scripts/eng/gitlab-land.mjs:434-440 (new): after a refused merge loses its turn, the loop goes on. It can call PUT …/merge for a younger merge request in the same tick, judged against the origin/main fetched once at :393. GitLab may still process the first call after the re-read (the client times out after 30 s). Then only GitLab's own refusal of a behind merge request (fast-forward method and 'pipelines must succeed', plan §3.3) prevents two landings on an untested main. The bot does not prevent it, and under the merge-commit fallback of plan §8 nothing would. The 60 minutes count from the pipeline's creation, so a merge request that waited behind others loses its turn on its first refusal. Consider ending the project's tick after any merge call that was not confirmed, or re-fetching main first.
Findings: non-blocking: .kiro/specs/eng-gitlab-m2/lanes/merge-bot.md:63: the 16:20Z answer defers items to lanes that do not record them on main. Lane settings' paths (lanes/settings.md:11-26) do not include vitana-land.service, so it cannot add User= and sandboxing to this unit as stated, and neither its lane file nor its tasks name the item. The merge-queue tasks of agentic-delivery do not name the pipeline-status item; its new review source does cover eventPages. Record both in the target lanes through _plan, or in this lane's closing record.
Findings: non-blocking: CI on 363560d8 was not read by this review: gh pr view and gh pr checks need GraphQL here, and gh api is not an allowed command. The verdict relies on the caller's REST read at 16:50:53Z: 12 check names green, unit included, and the cancelled runs are superseded duplicates. land-guard.mjs checks said: ok, 12 checks green. The land step re-reads the checks on the head it merges.
Next: the land step merges under §7b once lane gitlab-client is done on origin/main (closing record PR #4693), after bringing the branch up to date with main and re-checking on that head.

### 2026-11-06T22:44Z · kiro-exafy-202611062222-c262 · in-review → verified
Closing record written by the plan driver kiro-exafy-202611062222-c262, which took over this lane's stale claim (holder silent > 24 h).
Review: the reviewer-agent accept by agent-vitana-lane-reviewer-202611051707-cc3b on head 363560d80e7428f61728e6fc91f27a51f30940e8 is in this log.
PR https://github.com/exafyltd/vitana-platform/pull/4697 merged at 2026-11-05T21:47:53Z by DraganOffice (the gh identity of the plan driver's review desk) with head 3cf330bb9e395b7321bccfbbb826ab817358c685.
`land-guard.mjs review --gh exafyltd/vitana-platform --repo . --pr 4697 --reviewed-head 363560d80e7428f61728e6fc91f27a51f30940e8` (run 2026-11-06T22:44Z): ok, only lane-file entries and clean merges of main after the reviewed head, so the accept counted for the merged head.
Checks on the merged head (REST check-runs read, 2026-11-06T22:44Z): 12 of 12 completed/success; none red or missing.

### 2026-11-06T22:44Z · kiro-exafy-202611062222-c262 · verified → done
merge: 72dbefbaaee7622793091eab2edc092d0e10a16e
authority: §7b PM rule (plan driver review desk; accept current on the merged head, checks green).
Gap: the lane said in-review, not verified, when it merged, and no merge line was written at the time; this entry records both.
Next: none; the lane is done.
