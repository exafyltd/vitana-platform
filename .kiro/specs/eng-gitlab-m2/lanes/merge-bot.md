---
lane: merge-bot
state: in-review
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
updated: 2026-11-05T11:09Z
claimed_by: kiro-exafy-202611021438-cff7
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
