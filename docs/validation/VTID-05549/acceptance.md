Change types: Tooling/docs, Integration.

# VTID-05549 acceptance — agentic-delivery/merge-queue

Outcome: reviewed, green merge requests of both repositories land one train at a time per repository in the right order
(the oldest accept first; revert and fix-main first while `main` is red); a red `main` stops normal landings until a fix or
revert lands; each landing carries its review facts into the squash commit on `main`; a converged plan lands without a
person. Built as the queue mode of the M2 merge bot `scripts/eng/gitlab-land.mjs` (on for the two projects of the cut,
`vitana-platform` and `vitana-v1`, once they have `landing: true`), plus `review-source.mjs` (cross-repo review entries),
`gitlab-gates.mjs` (the `lane-scope` and `collab-handoff` jobs) and `assist-trigger.mjs` (plan §3.9). `land-guard.mjs`
and `queue.mjs` are not edited.

How it was built: first on a local scratch base (F2 brief: origin/main `abe2d7a59f` plus the tree of merge-bot
`570fe18b55`), parked locally. After eng-gitlab-m2 merge-bot (#4697) landed as `72dbefbaae`, the branch was made anew from
origin/main `0f45367bb6` (it also holds #4718 and github-bridge #4689), the lane's five own commits were cherry-picked
(no conflict), one commit adapts the queue to merge-bot's final `gitlab-land.mjs` (AC-7a, AC-12, AC-14), and a follow-up
keeps a same-tick drop on the head the bot made (AC-7a). After eng-gitlab-m2 settings (#4711) landed, origin/main
`0e5a74a72a` was merged into the branch (no conflict) and the bot reads its projects through `loadEffectiveProjects`
(AC-15); its own train is called the landing train, so the settings lane's free-tier guard passes (AC-16).

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
A position is judged by the project's required jobs without the governance jobs that judge one merge request
(`lane-scope`, `collab-handoff`, `change-suite`, `pr-gate-report`; or by `train_required_jobs`): those run and are
required on each merge request's own head before it joins the train.
TEST: scripts/eng/gitlab-land-queue.test.mjs "trainSelect: …", "the train: positions train/1..k in queue order …", "lands merge request k only when its position is green and every earlier position has landed; main merged in with ci.skip; the tree on main is the tested tree", "a failed position drops its merge request …", "a conflicting position …", "the update's tree must equal the tested tree: …", "a train position needs the checks and gate, not the governance jobs that judge one merge request"

AC-7a Merge-bot's final rules in the train (#4697): a merge request whose merge of `main` conflicts is skipped with one
comment, and the younger ones go on in the same tick (M2's blocking fix); a position whose merge GitLab keeps refusing
holds the train for at most 60 minutes from its position pipeline's creation (M2's turn bound), then it is dropped
(`merge_refused_too_long`, one comment, until a new head) and the positions behind it are rebuilt without it; after a
refused merge no further merge call is made in that tick; a drop in the tick in which the bot merged `main` into the
branch is kept, and commented, for the head the bot made, so the merge request stays out until its builder pushes.
TEST: scripts/eng/gitlab-land-queue.test.mjs "a merge request whose merge of main conflicts is skipped with one comment, and the younger ones go on in the same tick (M2's conflict rule, in queue mode)", "a position whose merge GitLab keeps refusing holds the train for at most 60 minutes from its pipeline's creation; then it is dropped and the positions behind it are rebuilt without it", "a merge request dropped in the tick in which the bot merged main into it stays out for the head the bot made, with one comment"

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

AC-12 Which projects use the queue, and no writes without need: `vitana-platform` and `vitana-v1` use the queue by name
(`DEFAULTS.queueProjects`; `--queue-projects a,b` changes the list, an empty value turns it off), because the settings
schema of eng-gitlab-m2 lane `settings` allows no `queue` key; an entry's own `queue` (true, `{ "positions": 1..12 }`,
or false) wins; every other project (M2's `rehearsal`) keeps M2's loop. `--dry-run` writes nothing (no train ref,
label, comment, merge, state file) and logs what it would do; `status` prints each queue state and writes nothing.
TEST: scripts/eng/gitlab-land-queue.test.mjs "queue mode is on for the two projects of the cut by name (the settings schema has no queue key), off for any other project; an explicit setting wins", "loadProjects reads the queue setting; normalizeQueue allows 1 to 12 positions", "--dry-run writes nothing: …", "status in queue mode prints each merge request's queue state and writes nothing"; scripts/eng/gitlab-land.test.mjs (M2's 58 tests as merged, unchanged, green)

AC-13 Q3: `land-guard.mjs` and `queue.mjs` untouched (same blob ids as the base); a dry run over the fake GitLab with 12
merge requests (9 in vitana-platform: 7 lanes, 1 protected-file lane, 1 plan; 3 cross-repo vitana-v1 lanes): tick 0
`--dry-run` makes no API write and moves no ref, tick 1 builds both trains (8 + 3 positions) and refuses the protected
one once, tick 2 lands 8 and 3 in queue order with the trailers.
TEST: docs/validation/VTID-05549/outputs/untouched-guard-files.txt; docs/validation/VTID-05549/outputs/dry-run-12.mjs (transcript dry-run-12.txt, its assertions pass)

AC-14 Credentials (merge-bot #4697: every git command starts with `-c credential.helper=`): every git command the queue
runs with the bot's git environment (clone, fetch, `merge-tree`, `commit-tree`, `ls-remote`, the pushes of train refs,
updates and assist refs) carries the flag, so no configured credential helper can store the token from GIT_ASKPASS.
TEST: scripts/eng/gitlab-land-queue.test.mjs "every git command of a queue tick starts with -c credential.helper=, as M2's bot does, so no configured helper can store the token"

AC-15 Projects through the cut configuration (cut checklist item `bot-config`): `run`, `merge` and `status` read the
projects through `loadEffectiveProjects` of `scripts/eng/gitlab-settings.mjs` (the view of the delivery cutover marker:
after the cut the two projects land) when that module exports it, passing the settings file and `--marker-file` /
`--ci-dir` when given; while it does not (lane settings alone, before lane cutover), the settings file itself, as M2
reads it; a loader error lands nothing (exit 1, no GitLab call); `projectsOverride` (tests) still wins.
TEST: scripts/eng/gitlab-land-queue.test.mjs "run and status read the projects through loadEffectiveProjects of gitlab-settings.mjs (the cut configuration) when it exports it, else the settings file as M2 does; a loader error lands nothing"

AC-16 Free tier: no Premium-only name in the bot's code: the free-tier guard of eng-gitlab-m2 lane `settings` scans
`scripts/eng/**` and refuses the words "merge train" (GitLab's Premium feature) outside comments; the queue's own train
is the "landing train" in every comment text and drop reason, and the guard passes on the lane's tree.
TEST: scripts/eng/free-tier-guard.test.mjs "free-tier guard: the repository today names no Premium-only API path or setting (scans infra/gitlab-engineering and scripts/eng)" (unchanged, in UNIT's run); scripts/eng/gitlab-land-queue.test.mjs "a failed position drops its merge request …" (reads the new text)

States: platform project unreachable → the project's tick fails, nothing lands (AC-2); two accepts → the newest current
one counts (AC-1); accept on an old head → refused, `queue-blocked`, one comment (AC-2, AC-11); `main` red →
`queue-paused` except revert / fix-main (AC-5); hot file → `queue-waiting` until the STAGING-VERIFY result (AC-6);
protected file → refused, one comment (AC-11); assist pending → `queue-waiting` (AC-4); position failed or conflicting →
dropped, `queue-blocked`, one comment (AC-7); merge of `main` conflicts → skipped, one comment, the younger ones go on
(AC-7a); merge refused → kept 60 minutes, then dropped (AC-7a); plan not approved or PLAN-SPAR not green →
`queue-waiting` (AC-8).

Surfaces: merge requests of the landing projects (labels, notes, the merge call); the bot refs `train/<k>` and
`assist/<iid>-<rule>`; the required jobs `lane-scope` and `collab-handoff` of the generated pipelines (lane `pipelines`
wires them); the train state file `<workdir>/<project>.train.json` on the trusted host.

Locales: n/a. Accessibility: n/a.

Contract:
- `land-guard.mjs` unchanged: `reviewCurrent` scripts/collab/land-guard.mjs:59, `checksVerdict` :85, `protectedTouched` :103,
  `mergeDecision` :108, `localAfter` :166; called from scripts/eng/gitlab-land.mjs:725-738 (`sameRepoReview`), :720 (through
  M2's `checksFor`), and scripts/eng/review-source.mjs:111-117 (`crossRepoReview`).
- `queue.mjs` unchanged: `validateRange` scripts/collab/queue.mjs:779, `scopeCheck` :946 (tasks.md says :912; VTID-05331,
  `abe2d7a59f`, moved it before this lane), `commitsInRange` :669; called from scripts/eng/gitlab-gates.mjs:92, :103 and
  scripts/eng/gitlab-land.mjs:726.
- Merge-bot (M2, VTID-05538, merged as `72dbefbaae`; line numbers of origin/main) code this lane uses: `squashMessage`
  gitlab-land.mjs:169 (in `queueSquashMessage`, lane :576); `judgeReviewCommit` :140 and `pushedByReviewer` :249 with its
  `pushRange` :238 (in `sameRepoReview`, lane :725); `checksFor` :124 (in `pipelineChecks`, lane :716); `GIT_CONFIG_ARGS`
  :194 (also in the lane's `mergeTree`, lane :688); `lostItsTurn` :380 and `waitedMinutes` :384 (the train's refused-merge
  bound, lane :940); `gitRun` :196, `ensureClone` :218, `fetchMrHead` :232, `openMergeRequests` :374, `COMMENT_TEXT` :175,
  `PIPELINE_FINAL` :121, `REVIEWER_RE` :54. Edited M2 lines: the header comment and imports, `DEFAULTS` (+`services`,
  +`queueProjects`), the first two lines of `tickProject` (`queueSetting`, `tickQueue`; lane :402-404), `loadProjects`
  (+`queue`, `train_required_jobs`), `makeContext` (+`services`, `statusUsers`, `queueProjects`), `main` (the projects
  loader, lane :1135-1137), the usage line. Not used by
  the queue: `evaluate`, `decide`, `updateOne`, `landOne`, `ensureNote`, the `acted` loop.
- Trailers, labels and assist refs exactly as plan §3.5 and §3.9 name them; job names `lane-scope`, `collab-handoff`,
  `staging-verify` (plan §3.4, §3.6); status names `gitlab/plan-spar` and `PLAN-SPAR` (tasks.md Q1).
- Projects loader: `import * as gitlabSettings from './gitlab-settings.mjs'` (lane gitlab-land.mjs:52) and `readProjects`
  (lane :1084). `scripts/eng/gitlab-settings.mjs` on main (#4711, `0e5a74a72a`) exports no `loadEffectiveProjects`; the
  version on `origin/kiro/backup/cutover` (gitlab-settings.mjs:384, lane `cutover`) is
  `loadEffectiveProjects(settingsFile, { fs, markerFile, ciDir })` → `[{ name, path, landing, required_jobs }]`, and the
  bot calls it as `(file, { markerFile?, ciDir? })`. The cut checklist item `bot-config` greps gitlab-land.mjs on main for
  the name (`origin/kiro/backup/cutover:scripts/eng/delivery-cutover.sh:388`).
- Free-tier guard: `scripts/eng/free-tier-guard.test.mjs` (lane settings, unchanged) rule `merge trains`.

Staging proof: not verified on staging: it runs on the GitLab host in the engineering account, which has no staging; it
deploys nothing (`run.mjs check-pr`: outputs/staging-check-pr.txt). Proven by its tests and the 12-merge-request dry run
over the fake GitLab; live from the cut.

Red on base: outputs/red-on-base.txt — 32 of 32 fail on origin/main `0e5a74a72a` (3 files fail whole: missing modules; 29
queue tests fail); outputs/red-on-stub.txt — 30 of 30 fail against no-behaviour stubs outside the repo. The four tests
added for the adaptation: outputs/red-adapt.txt — on the cherry-picked code before the adaptation, 3 of 4 fail (the queue
switch by name, the refused-merge bound, the credential flag); the conflict case passes there (the queue already skipped
it; a regression test of M2's rule). The same-tick drop test: outputs/red-fix-same-tick.txt — 1 of 1 fails on the code of
PR head `43ef9402f5`. The loader test: outputs/red-effective.txt — 1 of 1 fails on the merge of main `a6e7c57c04`, also
without its source assertions. The guard: outputs/red-free-tier-guard.txt — red on that tree (5 lines said "merge train").
Green: outputs/green.txt — 117 of 117 pass (59 new: review-source 14, gitlab-gates 8, assist-trigger 8, gitlab-land-queue
29; plus M2's gitlab-land.test.mjs 58, unchanged); outputs/unit-all.txt — UNIT's full command: 1085 tests, 1083 pass, 0 fail,
2 skipped (pre-existing on main: a win32-only case; the settings guard's PyYAML case, PyYAML is not installed here); the
free-tier guard passes on the lane's tree.

Decisions taken (inside the plan):
1. Queue mode is on, by name, for `vitana-platform` and `vitana-v1`, the two projects the cut lands (plan §3.5, §8.2),
   once they have `landing: true`; before the cut neither is a landing project, so nothing changes until then. The first
   build read a settings key `queue`, but the settings sync of eng-gitlab-m2 lane `settings` refuses unknown project keys
   (`origin/kiro/eng-gitlab-m2/settings` `eec9c24313`, scripts/eng/gitlab-settings.mjs `SCHEMA_KEYS.project` :72, `onlyKeys` :165), and
   the cutover's `loadEffectiveProjects` returns no such key. A `queue` value that a loader or `projectsOverride` passes still
   wins (growing the train to 12, plan §5); `--queue-projects` changes the list without a code change.
2. Every queue project other than vitana-platform reads its review entries cross-repo from the platform project;
   vitana-platform keeps M2's push-identity check (plan §3.5 "Same-repo lanes keep M2's push-identity check").
3. The accept time that orders the queue and fills `Accepted-At` is the committer time of the accept entry; a plan merge
   request is ordered by the time of its successful PLAN-SPAR status.
4. Trusted authors of `gitlab/plan-spar` / `PLAN-SPAR` statuses default to `bot-land` (`ctx.statusUsers`). The bridge now on
   main (github-bridge #4689) posts GitLab job results to GitHub as `gitlab/<job>`, but no code relays PLAN-SPAR's GitHub
   result to the GitLab commit (plan §3.5: "its result reaches GitLab through the bridge"). Until that relay or the
   GitLab `plan-spar` job (plan §4, after the cut) exists, a `plan(` merge request waits (`plan_spar_pending`, fails
   closed). Named for the driver.
5. A merge request that changes a file a merge request ahead of it in the train changes waits for the next cycle instead
   of risking a drop; one that git cannot merge (a file/directory conflict) is dropped.
6. "The previous hot-file landing" = the newest of the last 50 first-parent commits of `main` that shares a hot key; its
   result = every `staging-verify*` job of its `main` pipeline finished (or the pipeline finished without one); with no
   pipeline at all it waits at most the bot's 60-minute pipeline wait. A manual STAGING-VERIFY job is no result.
7. `main` is red when its newest finished landing pipeline (source `push`, success or failed) failed; a canceled or
   scheduled (nightly) pipeline does not decide.
8. A dropped merge request stays out (blocked) until its head changes; the drop is kept in the train state file.
9. A refused merge call keeps its position and is retried at the next tick, for at most 60 minutes from the position
   pipeline's creation (M2's turn bound since #4697, `lostItsTurn`); then the merge request leaves the train
   (`merge_refused_too_long`). The bound counts from the position pipeline because a train merge request's own pipeline
   is older than its position. A position whose pipeline stays pending is not bounded by the bot: GitLab's job timeout
   ends it, and a failed or canceled position is dropped (AC-7). A head the bot made (main merged in with `ci.skip`) is
   judged by the checks of the head it was made from, and from the moment the bot pushes it, it is the merge request's
   head for that tick's drop and comment.
10. Train refs move by delete-then-push, never by force; the train state file is only a cache: a lost or unreadable one
    makes the bot rebuild the train.
11. `gitlab-land.mjs merge <project> <iid>` on a queue project runs a normal queue tick (nothing jumps the queue) and
    reports that merge request.
12. The cross-repo queue test accepts web-c's head after the reviewer's own commit, so the builder rule, not staleness,
    is what refuses it.
13. The dry-run test compares refs after removing the fake's `refs/merge-requests/*` with `.trim()` (the fake leaves a
    trailing newline there).
14. A train position does not require the governance jobs that judge one merge request (`MR_ONLY_JOBS`): `scopeCheck`
    refuses a range that names two lanes, so `lane-scope` cannot pass on `train/<k>` for k ≥ 2; they stay required on each
    merge request's own head. Lane `pipelines` should run them only in merge-request pipelines and run `gate` and the
    checks on `train/*` refs; a `train_required_jobs` value overrides the default. With the cut's required jobs
    (`lane-scope`, `change-suite`, `gate`; plan §8.2 step 3) a position needs `gate`.
15. The assist ref is moved with a normal `git push` by `bot-land`, as plan §3.9 says ("only `bot-land` and the owner may
    push there"). Plan §7 says `main` and `assist/*` are protected with "push No one, merge Maintainers"; the settings must
    let `bot-land` push `assist/*`. Late lane `cut-settings` (VTID-05562, tasks C2) now owns that setting.
16. `train/*` are plain bot branches, not protected: their pipelines run on the untrusted class with no secret (§3.2), the
    bot trusts only the pipeline of the exact commit it built on that ref, and it moves them by delete-then-push. Late
    lane `cut-settings` (VTID-05562, tasks C2) keeps `train/*` unprotected.
17. Rebuild after merge-bot: branch made anew from origin/main `0f45367bb6`; the lane's five own commits cherry-picked
    unchanged (no conflict; the scratch commit and the first rebuild on `d73fec53f9` stay local, never pushed); the
    adaptation is one new commit with its tests recorded red first (outputs/red-adapt.txt).
18. Every git command the queue runs itself starts with M2's `GIT_CONFIG_ARGS` (the one direct `execFileSync` of
    `merge-tree` now too). The commands of `review-source.mjs`, `land-guard.mjs` and `queue.mjs` read only local clones and
    run with the process environment, as M2's test notes for its own imports.
19. Merge-bot deferred two items to this lane (`.kiro/specs/eng-gitlab-m2/lanes/merge-bot.md`, entry 16:20Z): failing
    closed on a finished pipeline whose own status is not `success`, and `eventPages`. Neither is in this lane's tasks
    (the reviewer of 17:07Z noted the same). Not built: a train position is judged by its jobs as M2 judges a head; the
    cross-repo source reads no push events, and same-repo lanes keep M2's push-identity check with its 500-event window
    (an aged-out accept is refused, never landed). Named for the driver.
20. The projects loader uses `loadEffectiveProjects` only when `gitlab-settings.mjs` exports it. The F3 brief placed the
    function in lane settings (#4711), but #4711 landed without it; a version exists only on lane cutover's backup, and plan
    §9 orders cutover after this lane. A named import would break the bot until cutover lands, so the namespace import
    reads the function when it exists; until then the bot reads the settings file itself, which gives the same view for a
    file without cutover blocks (`effectiveConfig` on the cutover backup: "An inactive project … come out unchanged"). The
    cut checklist item `bot-config` (a grep for the name) passes once this lane is on main. Named for the driver: lane
    cutover must export `loadEffectiveProjects(settingsFile, { markerFile, ciDir })` with that result shape.
21. The queue's own train is called the "landing train" in comments to members and in drop reasons: the settings lane's
    free-tier guard refuses "merge train" (GitLab's Premium feature) outside comment lines. Code comments keep "train".
