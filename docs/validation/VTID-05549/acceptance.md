Change types: Tooling/docs, Integration.

# VTID-05549 acceptance — agentic-delivery/merge-queue

Outcome: reviewed, green merge requests of both repositories land one train at a time per repository in the right order
(the oldest accept first; revert and fix-main first while `main` is red); a red `main` stops normal landings until a fix or
revert lands; each landing carries its review facts into the squash commit on `main`; a converged plan lands without a
person. Built as the queue mode of the M2 merge bot `scripts/eng/gitlab-land.mjs` (a project whose settings entry has
`queue`), plus `review-source.mjs` (cross-repo review entries), `gitlab-gates.mjs` (the `lane-scope` and
`collab-handoff` jobs) and `assist-trigger.mjs` (plan §3.9). `land-guard.mjs` and `queue.mjs` are not edited.

Built on a local scratch base (F2 brief): `5209c22376` = origin/main `abe2d7a59f` plus the tree of
`origin/kiro/eng-gitlab-m2/merge-bot` `570fe18b55` (main after merge-bot). Parked locally, not pushed; the driver rebuilds
it from origin/main after merge-bot (#4697) lands.

AC-1 Cross-repo review source (plan §3.5): a vitana-v1 merge request titled `VTID-xxxxx (<slug>/<lane>): …` is judged by
the review entry in the platform lane file `.kiro/specs/<slug>/lanes/<lane>.md`, read from the bot's clone of
vitana-platform: `main` first, then the branches `kiro/<slug>/*`; of two accepts the newest one that `reviewCurrent`
accepts for the merge request's commits counts; an entry on both refs is read once.
TEST: scripts/eng/review-source.test.mjs "finds the accept for <slug>/<lane> on platform main", "then on kiro/<slug>/* branches of the platform project, bridged or native", "an accept on main and one on a branch: the newest current one counts; an entry on both is read once"

AC-2 Cross-repo refusals: an entry `reviewCurrent` rejects (code after the reviewed head, a force-push), a reviewer
session that appears on a commit of the merge request, a model outside the reviewer chain, a `changes` verdict (also
over an older accept), a session that is not a reviewer agent; a platform clone without `main` or an unreachable
platform project fails closed (the project's tick fails, nothing lands, no train is built).
TEST: scripts/eng/review-source.test.mjs "refuses an entry that reviewCurrent rejects …", "an accept on an old head that is no longer in the merge request's history (force-push) is refused", "refuses an accept whose reviewer session appears on a commit of the merge request", "refuses an accept by a model outside the chain", "refuses a changes verdict, also when an older accept exists", "an entry that is not from a reviewer agent session is refused", "a platform clone without main fails closed: an error, never an accept"; scripts/eng/gitlab-land-queue.test.mjs "cross-repo: vitana-v1 lanes land on their platform review entries; a reviewer session on a merge-request commit is refused; an unreachable platform lands nothing"

AC-3 Governance jobs (plan §3.4, §4): `gitlab-gates.mjs lane-scope` calls `scopeCheck` and `collab-handoff` calls
`validateRange` (plus the programme and seat checks of `queue.mjs validate`) unchanged, with fetchers over a local clone of
the platform project fetched with the job's token (askpass, never a command line); same verdicts as `queue.mjs` on the
same inputs; in the platform project `fetchLane` stays off as in PR-GATE; an unreachable platform project exits 3.
TEST: scripts/eng/gitlab-gates.test.mjs (all 8 tests, e.g. "in the platform project lane-scope and collab-handoff give the verdicts of `queue.mjs scope-check` and `queue.mjs validate`", "an unreachable platform project fails closed: exit 3 for both jobs, nothing passes")

AC-4 Assist trigger (plan §3.9): one protected ref `assist/<iid>-<rule>` moved to `main` with `ci.skip` (never a force) and
one pipeline with ASSIST_MR_IID / ASSIST_MR_HEAD / ASSIST_RULE / ASSIST_SOURCE_BRANCH per head and rule; the merge
request waits (`queue-waiting`) while it runs; never after an accept; never for a protected-file merge request.
TEST: scripts/eng/assist-trigger.test.mjs (8 tests); scripts/eng/gitlab-land-queue.test.mjs "assist: one assist/<iid>-<rule> pipeline per head and rule; the merge request waits for it; never after an accept"

AC-5 Order and red main (plan §3.5 "Order", "Main red pauses landing"): the oldest accept first (ties: older merge
request, lower iid); while the newest finished landing pipeline of `main` failed, only revert and fix-main lanes are
queued (first), the rest get `queue-paused`; landing resumes when `main` is green.
TEST: scripts/eng/gitlab-land-queue.test.mjs "queueOrder: …", "fixFirst names the revert and fix-main lanes; mainRed reads the newest finished landing pipeline of main", "a red main pauses the rest (queue-paused); a fix-main lane lands first; landing resumes when main is green"

AC-6 Hot files (collaboration.md §8a item 4): a merge request that touches a hot file waits (`queue-waiting`) until the
previous landing of the same hot key on `main` has its STAGING-VERIFY result; the others do not wait for it; one merge
request per hot key per train.
TEST: scripts/eng/gitlab-land-queue.test.mjs "hotKeys: the hot files of collaboration.md §8a item 4, i18n shards by namespace", "a hot-file merge request waits until the previous hot-file landing has its STAGING-VERIFY result"

AC-7 Train (plan §3.5 "Train"): up to `positions` (8; 1 to 12) positions in queue order; position k is the bot ref
`train/<k>` = `main` (or position k-1) merged with merge request k; merge request k lands only when position k is green
and positions 1..k-1 have landed, after `main` is merged into it with `ci.skip` and the new head's tree equals position
k's tested tree (pinned `sha`, squash); a failed or conflicting position drops its merge request (one comment,
`queue-blocked`, back to its builder until a new head) and the positions behind it are rebuilt without it; a tree
mismatch or a `main` moved by someone else rebuilds the train and lands nothing; every state of `main` is a tested tree.
TEST: scripts/eng/gitlab-land-queue.test.mjs "trainSelect: …", "the train: positions train/1..k in queue order …", "lands merge request k only when its position is green and every earlier position has landed; main merged in with ci.skip; the tree on main is the tested tree", "a failed position drops its merge request …", "a conflicting position …", "the update's tree must equal the tested tree: …"

AC-8 Plan merge requests (plan §3.5, planning.md §6): a `plan(` merge request lands only when `handoff.md` on its head
says `approved` with a `sparring_record`, the last `gitlab/plan-spar` or `PLAN-SPAR` commit status from a trusted account
on its head succeeded, and its pipeline's required (governance) jobs pass; one that changes more than its spec folder and
the program entry is refused once; its squash message has the two trailers `Merge-Request` and `Source-Branch`.
TEST: scripts/eng/gitlab-land-queue.test.mjs "planSparVerdict and planGate: …", "a plan( merge request lands only with approved, a sparring_record and a successful plan-spar status on its head", "a plan( merge request that changes more than its spec folder and the program entry is refused once"

AC-9 Squash message (plan §3.5): the title (VTID first) and description, then the trailers `Merge-Request: !<iid>`,
`Source-Branch:`, `Reviewed-Head:`, `Review-Verdict: accept`, `Reviewer: agent:vitana-lane-reviewer (<model>)`,
`Accepted-At:` as git's own trailer block; same-repo and cross-repo landings carry them on `main`.
TEST: scripts/eng/gitlab-land-queue.test.mjs "queueSquashMessage starts with the VTID and ends with the six trailers git reads as trailers; a plan merge request has two", "lands merge request k …" (trailers read with git on main), "cross-repo: …" (Reviewed-Head, Merge-Request, Accepted-At of a vitana-v1 landing)

AC-10 Queue labels (plan §3.5): exactly one of `queue-ready`, `queue-updating`, `queue-waiting`, `queue-blocked`,
`queue-paused`, each written once per state (no write when unchanged), other labels untouched, none on a draft.
TEST: scripts/eng/gitlab-land-queue.test.mjs "labelChange sets exactly one queue label, once per state, and leaves other labels alone", "the train: … queue labels set once"

AC-11 Protected gate files and old heads: a merge request that changes a protected gate file is refused with one
comment and never enters the train or an assist (the owner merges it, M2); an accept on an old head is refused; one
comment per head and reason.
TEST: scripts/eng/gitlab-land-queue.test.mjs "a protected gate file is refused with one comment and never enters the train; an accept on an old head is refused"

AC-12 No writes without need: `--dry-run` writes nothing (no train ref, label, comment, merge, state file) and logs what it
would do; `status` prints each merge request's queue state and writes nothing; the settings `queue` key (true or
`{ "positions": 1..12 }`) is read by `loadProjects`, a project without it keeps M2's loop.
TEST: scripts/eng/gitlab-land-queue.test.mjs "--dry-run writes nothing: …", "status in queue mode prints each merge request's queue state and writes nothing", "loadProjects reads the queue setting; normalizeQueue allows 1 to 12 positions"; scripts/eng/gitlab-land.test.mjs (M2's 54 tests, unchanged, green)

AC-13 Q3: `land-guard.mjs` and `queue.mjs` untouched (same blob ids as the base); a dry run over the fake GitLab with 12
merge requests (9 in vitana-platform: 7 lanes, 1 protected-file lane, 1 plan; 3 cross-repo vitana-v1 lanes): tick 0
`--dry-run` makes no API write and moves no ref, tick 1 builds both trains (8 + 3 positions) and refuses the protected
one once, tick 2 lands 8 and 3 in queue order with the trailers.
TEST: docs/validation/VTID-05549/outputs/untouched-guard-files.txt; docs/validation/VTID-05549/outputs/dry-run-12.mjs (transcript dry-run-12.txt, its assertions pass)

States: platform project unreachable → the project's tick fails, nothing lands (AC-2); two accepts → the newest current
one counts (AC-1); accept on an old head → refused, `queue-blocked`, one comment (AC-2, AC-11); `main` red →
`queue-paused` except revert / fix-main (AC-5); hot file → `queue-waiting` until the STAGING-VERIFY result (AC-6);
protected file → refused, one comment (AC-11); assist pending → `queue-waiting` (AC-4); position failed or conflicting →
dropped, `queue-blocked`, one comment (AC-7); plan not approved or PLAN-SPAR not green → `queue-waiting` (AC-8).

Surfaces: merge requests of the landing projects (labels, notes, the merge call); the bot refs `train/<k>` and
`assist/<iid>-<rule>`; the required jobs `lane-scope` and `collab-handoff` of the generated pipelines (lane `pipelines`
wires them); the train state file `<workdir>/<project>.train.json` on the trusted host.

Locales: n/a. Accessibility: n/a.

Contract:
- `land-guard.mjs` unchanged: `reviewCurrent` scripts/collab/land-guard.mjs:59, `checksVerdict` :85, `protectedTouched` :103,
  `mergeDecision` :108, `localAfter` :166; called from scripts/eng/gitlab-land.mjs:647-660 (`sameRepoReview`), :129 (M2
  `checksFor`), and scripts/eng/review-source.mjs:108-119 (`crossRepoReview`).
- `queue.mjs` unchanged: `validateRange` scripts/collab/queue.mjs:779, `scopeCheck` :946 (tasks.md says :912; VTID-05331,
  `abe2d7a59f`, moved it before this lane), `commitsInRange` :669; called from scripts/eng/gitlab-gates.mjs:91-118.
- Merge-bot (M2, VTID-05538, PR #4697, scratch-base line numbers) functions this lane depends on — keep them, or adapt
  these call sites when the merge-bot fix lands: `squashMessage` (gitlab-land.mjs:165 on the base) in `queueSquashMessage`;
  `judgeReviewCommit` (:136) and `pushedByReviewer` (:236, incl. its `pushRange`) in `sameRepoReview`; `checksFor` (:120)
  in `pipelineChecks`; the internals `gitRun` (:186), `ensureClone` (:208), `fetchMrHead` (:222), `openMergeRequests`
  (:361), `COMMENT_TEXT` (:171), `PIPELINE_FINAL` (:117), `REVIEWER_RE` (:50). Edited M2 lines: the header comment and
  imports, `DEFAULTS.services`, the first line of `tickProject` (`if (project.queue) return tickQueue(…)`), `loadProjects`
  (+`queue`), `makeContext` (+`services`, `statusUsers`). Not used: `evaluate`, `decide`, `updateOne`, `landOne`,
  `ensureNote`, the `acted` loop — the code the blocking review finding of 14:13Z changes.
- Trailers, labels and assist refs exactly as plan §3.5 and §3.9 name them; job names `lane-scope`, `collab-handoff`,
  `staging-verify` (plan §3.4, §3.6); status names `gitlab/plan-spar` and `PLAN-SPAR` (tasks.md Q1).

Staging proof: not verified on staging: it runs on the GitLab host in the engineering account, which has no staging; it
deploys nothing (`run.mjs check-pr`: outputs/staging-check-pr.txt). Proven by its tests and the 12-merge-request dry run
over the fake GitLab; live from the cut (lane `cutover` sets `queue` in the settings).

Red on base: outputs/red-on-base.txt — 25 of 25 fail on the scratch base (3 files fail whole: missing modules; 22 queue
tests fail); outputs/red-on-stub.txt — 30 of 30 fail against no-behaviour stubs outside the repo.
Green: outputs/green.txt — 106 of 106 pass (52 new: review-source 14, gitlab-gates 8, assist-trigger 8, gitlab-land-queue
22; plus M2's gitlab-land.test.mjs 54 unchanged); outputs/unit-all.txt — UNIT's full command 727 tests, 726 pass, 0 fail,
1 skipped (a pre-existing win32-only case).

Decisions taken (inside the plan):
1. Queue mode is opt-in per project (`queue` in its settings entry); without it the M2 loop is unchanged. The settings
   file belongs to lane `cutover`, which sets the key at the cut.
2. Every queue project other than vitana-platform reads its review entries cross-repo from the platform project;
   vitana-platform keeps M2's push-identity check (plan §3.5 "Same-repo lanes keep M2's push-identity check").
3. The accept time that orders the queue and fills `Accepted-At` is the committer time of the accept entry; a plan merge
   request is ordered by the time of its successful PLAN-SPAR status.
4. Trusted authors of `gitlab/plan-spar` / `PLAN-SPAR` statuses default to `bot-land` (`ctx.statusUsers`); the
   github-bridge lane must post PLAN-SPAR's result with that account, or the list gets its account.
5. A merge request that changes a file a merge request ahead of it in the train changes waits for the next cycle instead
   of risking a drop; one that git cannot merge (a file/directory conflict) is dropped.
6. "The previous hot-file landing" = the newest of the last 50 first-parent commits of `main` that shares a hot key; its
   result = every `staging-verify*` job of its `main` pipeline finished (or the pipeline finished without one); with no
   pipeline at all it waits at most the bot's 60-minute pipeline wait. A manual STAGING-VERIFY job is no result.
7. `main` is red when its newest finished landing pipeline (source `push`, success or failed) failed; a canceled or
   scheduled (nightly) pipeline does not decide.
8. A dropped merge request stays out (blocked) until its head changes; the drop is kept in the train state file.
9. A refused merge call keeps the position and is retried at the next tick, as M2's `landOne`; a head the bot made (main
   merged in with `ci.skip`) is judged by the checks of the head it was made from.
10. Train refs move by delete-then-push, never by force; the train state file is only a cache: a lost or unreadable one
    makes the bot rebuild the train.
11. `gitlab-land.mjs merge <project> <iid>` on a queue project runs a normal queue tick (nothing jumps the queue) and
    reports that merge request.
12. The cross-repo queue test accepts web-c's head after the reviewer's own commit, so the builder rule, not staleness,
    is what refuses it (the interrupted run's version was masked by `review_stale`).
13. The dry-run test compares refs after removing the fake's `refs/merge-requests/*` with `.trim()` (the earlier version
    failed only on the trailing newline those refs leave).
