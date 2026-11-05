Change types: Integration, Infrastructure/CI.
# VTID-05548 acceptance (agentic-delivery/github-bridge)
Outcome: an agent that can only push to GitHub keeps working after the cut. Within about a minute its `kiro/*` or
`claude/*` branch and its pull request appear on GitLab as a branch and a merge request, its checks run there, the job
results come back to the pull request as `gitlab/<job>` commit statuses, and the pull request is closed with a link when
the merge request lands. Built as `scripts/eng/github-bridge.mjs` (uses M2's `scripts/eng/gitlab-api.mjs` unchanged), the
systemd units `infra/gitlab-engineering/host/units/vitana-github-bridge.{service,timer}` and
`infra/gitlab-engineering/RUNBOOK-github-bridge.md`. Nothing deploys on merge; the timer is installed but not enabled
before the cut, and the cut enables it (§8.2 step 5).

AC-1 Only `kiro/*` and `claude/*` branches of exafyltd/vitana-platform (→ GitLab vitana/vitana-platform) and
exafyltd/vitana-v1 (→ vitana/vitana-v1) are copied; never `main`, `assist/*`, `pm-agent/*`, any other name or a
malformed ref name (no `..`, `//`, `.lock`, refspec characters). Both repositories in one tick.
TEST: scripts/eng/github-bridge.test.mjs "BRIDGE_REPOS pairs…", "isBridgedBranch: kiro/* and claude/* only…", "a tick copies the kiro/* and claude/* branches of both repositories to GitLab, and never main, assist/*, pm-agent/* or another name"
AC-2 One writer per branch (plan §3.1 principle 1). GitLab branch missing → created; GitLab at the head the bridge
pushed last → the GitHub head is copied, a force-push too; GitLab at the GitHub head or one of its ancestors (the M1
mirror's copy) → adopted without a push, or adopted and fast-forwarded; anything else → refused, nothing pushed, no
merge request, reported once per (branch, GitLab head) as `branch_refused`. A write on GitLab to a copied branch makes it
refused and is never overwritten; every push carries the head it expects (`--force-with-lease`), so a write that races a
copy stays. A refused branch whose GitLab copy a person deleted is copied again. A branch deleted on GitHub stays the
bridge's while GitLab has its copy. The merge bot's clean merges of `main` on top of the bridge's copy (eng-gitlab-m2
§3.4, plan §3.5) keep the branch bridged and a new GitHub head is copied over them; a merge that adds its own change is
another writer. A second tick with nothing new pushes, fetches and writes nothing.
TEST: "a new commit and a force-push on GitHub are copied…", "a branch that already lives on GitLab with other history is refused…", "the same history already on GitLab (a mirror copy) is adopted…", "a write on GitLab to a branch the bridge copied makes it refused…", "a GitLab write that races a copy is never overwritten…", "a refused branch whose GitLab copy a person deleted is copied again…", "a branch deleted on GitHub stays the bridge's…", "the merge bot merging main into a bridged branch is not another writer…", "a new GitHub head after the merge bot merged main is copied over the bot's merge; a merge with other changes is refused", "a second tick with nothing new pushes nothing…"
AC-3 One GitLab merge request per open pull request into `main` from a bridged branch of the same repository: same title
(a draft pull request is a GitLab `Draft:`, which cannot be merged), same body (CRLF as LF; a line that starts with `/`
gets a backslash so it cannot run a GitLab quick action), source branch = head branch, target `main`. Updated when the
title or body changes, only when the bridge opened it; a merge request another account opened is never rewritten.
Closed when the pull request closes or leaves `main` without landing, only after GitHub confirms that no open pull
request from that branch into `main` is left. Forks, other head branches and other bases get none. A merge request a
person closed is not opened again for that head; a new head gets a new one.
TEST: "one merge request per open same-repository pull request from a bridged branch into main…", "merge request title and description…", "a pull request that closes without landing, or leaves main, has its merge request closed once…", "a merge request is closed only after GitHub confirms…", "a merge request someone else opened from a bridged branch is never rewritten…", "a merge request someone closed on GitLab while its pull request is open is reported once…"
AC-4 One GitHub commit status `gitlab/<job name>` per job result of the merge request's head pipeline, on the pull
request head (also when the pipeline ran on the bot's merge of `main` on top of it), `target_url` = the job page. The
state follows the eng-gitlab-m2 §3.4 job table (success; failed → failure, or success when allowed to fail; canceled →
error; skipped → success; manual → success when optional, pending when blocking; an unknown status → pending, never
success), except for the landing gate jobs `lane-scope`, `change-suite` and `gate`. The merge bot passes a required job
only when it is `success` (eng-gitlab-m2 plan.md:154-155), so for these three only `success` is success: skipped →
failure ("Skipped on GitLab: an earlier job did not pass"), failed and allowed to fail → failure, optional manual →
pending, canceled → error, unknown → pending. While the head pipeline has not ended and has no gate result,
`gitlab/gate` is pending ("GitLab pipeline running", `target_url` = the pipeline page), once per head, until the real
result replaces it; a pipeline that ended without a gate job (the bot's `ci.skip` train update, plan §3.5) adds no
status. A status equal to the latest one of its context on that commit is never posted (a cache, and GitHub's latest
statuses when the cache is lost). Waiting and running jobs get no status of their own. GitHub's content write limits: at
most 60 status writes a tick and 450 in any hour. Each tick posts in three groups across all its pull requests: the gate
results that are not success (the pending gate included), then the other gate results, then the other jobs; within a
group in rotation order. So as long as a tick can post anything, GitHub never shows only success for a red or running
pipeline: with a budget of 1, the one status posted is the non-success gate, also when another pull request comes first
in the rotation. The next tick starts with the pull request left without a turn; a GitHub rate limit stops every GitHub
write for the rest of the tick and pauses them until it has passed.
TEST: "jobToStatus maps every GitLab job status…", "jobToStatus: a landing gate job (lane-scope, change-suite, gate) is success on GitHub only when it passed…", "statuses: one gitlab/<job> commit status per job result…", "a failed check and a skipped gate give gitlab/gate failure on GitHub…", "with a status budget of 1, GitHub never shows only success for a red pipeline…", "while the head pipeline runs without a gate result, gitlab/gate is pending on GitHub…", "statuses are posted only for the head pipeline of the merge request at the pull request head", "status writes stay under GitHub content limits…", "the status budget goes first to the jobs that gate a landing…", "a GitHub rate limit stops every GitHub write…"
AC-5 After the merge request lands, the pull request is closed with one comment that links the landed commit and the
merge request (a marker keeps a retried close from commenting twice). Landing is found from the merged merge request's
head (`refs/merge-requests/<iid>/head`), also when that head is the bot's merge of `main` (the train update the bridge
never saw). The landed head is not copied to GitLab again, also after a lost state; new commits pushed after the landing
are copied and get a new merge request.
TEST: "after the merge request lands, the pull request is closed with one comment…", "a landing right after the merge bot merged main…", "new commits pushed to a branch after its merge request landed are copied again and get a new merge request"
AC-6 `assist-push` pushes a given commit to the GitHub branch with the bridge's GitHub credential only when the branch is a
`kiro/*` or `claude/*` branch the bridge copied, GitLab still has the bridge's copy, the source is a protected assist ref
(`refs/heads/assist/...`) that points at the commit, and the commit is one commit on top of the GitHub head (a
fast-forward, pushed with that head as the lease). Anything else is refused (exit 3) and pushes nothing; `--dry-run`
pushes nothing; the next tick copies the new head to GitLab.
TEST: "assist push: one commit on top of the head of a bridged branch goes to the GitHub branch; anything else is refused…", "assist push refuses a branch whose GitLab copy another writer changed, and a branch that is gone from GitHub", "CLI assist-push uses the saved state…"
AC-7 `--dry-run` writes nothing anywhere: no git push or fetch, no API write, no state write, no git command in the
service's cache (it reads the cache through a throw-away repository); it prints the planned actions as `planned` lines.
A branch it cannot judge without a fetch is planned as `check_history`.
TEST: "--dry-run writes nothing anywhere…", "a dry run that cannot judge a branch's history without a fetch plans check_history and fetches nothing"
AC-8 Any API or git error changes nothing for that branch in that tick (a read every branch of a repository needs:
nothing for that repository) and is retried at the next tick; the other branches and the other repository go on. A
corrupt state file, a missing token file or a bad option stop the CLI with exit 2 before any call; a tick with errors
exits 1.
TEST: "GitHub API down: nothing changes for that repository…", "GitLab API down…", "a git error on one branch changes nothing for that branch…", "an API error on one pull request leaves it for the next tick…", "CLI: a corrupt state file, a missing token file, an unknown command or option stop with exit 2 before any call", "state: saved atomically…"
AC-9 No token in any log line, error or output, also when a server echoes it (the token, its base64 and Basic-auth forms,
GitHub and GitLab token shapes, bearer and basic values are redacted). Tokens are read from files (`--github-token-file`,
`--gitlab-token-file`, defaults under `/etc/vitana/`); an option that would carry a token is refused. git gets each token
only through `GIT_CONFIG_*` environment entries (`http.<origin>/.extraHeader`) for its own host, never in argv or a URL;
a URL with credentials or plain http is refused. Log lines are JSON.
TEST: "tokens come from files, never from argv, and appear in no log line or error…", "git gets each token only through the environment and only for its own host…", "makeRedactor removes the tokens…", "readTokenFile: trims the token…"
AC-10 The GitHub client sends the token as one bearer header to one origin; a path must be a plain path; redirects are
never followed; a pagination link must stay on the origin; a GET is retried on 5xx and network errors, a write never; a
rate limit (429, a 403 with no quota left, Retry-After or a secondary-limit message) is an error left to a later tick;
errors carry status, method and the path without its query, never the token.
TEST: "GitHub client: the token goes in one Authorization header…", "GitHub client: paginate follows rel=\"next\" links on the same origin only", "GitHub client: a GET is retried on 5xx…", "GitHub client: an error carries status, method and the path…"
AC-11 Host units: the timer fires every minute (`OnCalendar=minutely`); the oneshot service runs the tick through
`flock --nonblock --conflict-exit-code 75` (exit 75 counted as success) so two ticks never overlap, with `Nice`,
`CPUQuota`, `MemoryMax`, `DynamicUser`, `ProtectSystem=strict` and further hardening; the two tokens come in as systemd
credentials (`LoadCredential`, `%d`), never in the unit; a missing token file fails visibly (`AssertPathExists`).
TEST: "systemd units: the timer fires every minute…"; outputs/systemd-verify.txt (`systemd-analyze verify`: no warning)
AC-12 The runbook names the token scopes, where the tokens live, the GitLab account's rights, how to read and resolve a
refused branch, how to start and stop the bridge, the dry run and assist pushes. It says that the timer is installed but
not enabled before the cut (the cut's step 5 enables it; `systemctl is-enabled` must print `disabled` before), how gate
results and the pending gate are posted, and the limits that stay: a refused branch's pull request shows no `gitlab/*`
status; statuses come only from job results plus the pending gate; the budget is a sliding hour.
TEST: "the runbook names the token scopes…", "the runbook says the timer is installed but not enabled before the cut…"
AC-13 Dry run against both repositories' open pull requests (task B3), read-only: 118 open in vitana-platform (84 get
`create_branch` and `create_merge_request`; 34 are ignored: 33 `pm-agent/*`, 1 `i18n-db/*`) and 31 in vitana-v1 (all
31 get both); 230 planned actions, 235 API calls, all GET, no error.
TEST: docs/validation/VTID-05548/outputs/dry-run.txt (harness outputs/dry-run-harness.mjs over a `gh api` GET snapshot, empty GitLab)

States: GitHub or GitLab API down (nothing changes for that repository, retried next tick); a git error on one branch
(that branch unchanged, the others go on); a branch with two writers (refused, reported once per GitLab head); the merge
bot's merge of `main` (still bridged); a PR from a fork (ignored); a PR closed or retargeted without landing (merge
request closed); a force-push to an agent branch (copied; the review rule decides whether the review still counts); a
landing (PR closed with a link, branch not copied again); a lost state (adopted again, nothing posted or opened twice); a
GitHub rate limit (writes paused); a dry run (nothing written); a red pipeline (`gitlab/gate` failure, posted first); a
running pipeline (`gitlab/gate` pending); a pipeline that ended without a gate job (nothing new posted); the status
budget used up (the rest later, red gate results first).
Surfaces: the trusted GitLab host (two systemd units, state directory `/var/lib/vitana/github-bridge`, token files under
`/etc/vitana/`); GitHub pull requests, comments and commit statuses of both repositories; GitLab branches and merge
requests of both projects.
Locales: n/a. Accessibility: n/a.
Contract: the branch rules and the status names `gitlab/<job>` of plan §3.13 and §9 (plan.md:408-417, :629); the token
scopes of plan §7 (in the runbook); the CLI (`run`, `assist-push`, options, exit codes 0/1/2/3), the JSON log events
(runbook table) and the state file schema `vitana.github-bridge-state/v1` (module header). The boundaries it crosses,
this side (`scripts/eng/github-bridge.mjs` at this PR's head) → the other side (a file on origin/main 945755f0, or the
plan section where no file exists yet; plan.md = `.kiro/specs/agentic-delivery/plan.md`):
- GitHub REST commit statuses: read `github-bridge.mjs:896-905` (GET `/repos/{repo}/commits/{sha}/status`), write
  `:998` (POST `/repos/{repo}/statuses/{sha}`); the states `:101-124` and the pending gate `:931-936`; the order
  `:130`, `:976`. Read on the other side by `scripts/collab/plan-driver.mjs:195-200` (`statusCheckRollup`: any
  FAILURE or ERROR → failed, PENDING → pending, no status → green); `scripts/collab/land-guard.mjs:207-210` reads check
  runs, not statuses. Status names: plan.md:415, :629.
- GitHub REST pull requests: list `:680`, the open-PR check before a close `:1020`, close `:891`; plan §3.13
  (plan.md:413-417). The client: `:242` (one origin, no redirect `:295`).
- GitHub REST issue comments (the landing link): read `:885`, write `:889`; plan §3.13 (plan.md:416).
- GitLab REST merge requests: list `:681`, `:752`, `:846`; create `:862`; update `:872`; close `:1025`; read with
  `head_pipeline` `:919-920`; `/user` `:662`. Through `scripts/eng/gitlab-api.mjs:198` (`createClient`, built at
  `:1142`), `:375` (`request`), `:382-397` (`paginate`, `x-next-page`), `:91` (`projectId`), unchanged.
- GitLab REST pipelines and jobs: `:925` (GET `/projects/{id}/pipelines/{pipeline}/jobs`, through
  `gitlab-api.mjs:382`). The merge bot's reading of the same jobs: `.kiro/specs/eng-gitlab-m2/plan.md:140-155` (job
  table; a required job must be `success`, :154-155); the required jobs at the cut: plan.md:584-585.
- git: `ls-remote` `:463`, `:511`; `fetch` `:441`; `push --force-with-lease` `:484` (to GitLab `:777`, `:814`; the assist
  commit to GitHub `:1071`). The other writer before the cut is the M1 mirror (`.kiro/specs/eng-gitlab-m1/plan.md:39`);
  one writer per branch: plan.md:165-167.
- The merge bot's merge of `main`: `:531` (`withoutMainMerges`), `:739` (`sameWork`), `:825` (`adopt_main_merge`), the
  landed head `refs/merge-requests/<iid>/head` `:522`. Other side: eng-gitlab-m2 plan.md:156 (behind `main`: the bot
  merges `origin/main` into the source branch), plan.md:254 (the train's update with `ci.skip`); a clean merge of `main`:
  `.claude/rules/collaboration.md:104-106`.
- The assist ref: `:1050` (only `refs/heads/assist/*`), `:1059` (the ref must point at the commit). Other side: plan §3.9
  (plan.md:325: only `bot-land` and the owner push `assist/<iid>-<rule>`), §7 (plan.md:529: `assist/*` protected), and
  the caller, lane `merge-queue` (open item below).
- Host units: `infra/gitlab-engineering/host/units/vitana-github-bridge.{service,timer}`, installed by `ops-install.sh`
  by glob (eng-gitlab-m2 plan.md:118-120, :236; `m2.sh install` :277) and enabled only by the cut (plan.md:588).
Staging proof: not verified on staging: the bridge runs in the engineering account on the GitLab host and touches no
product path; nothing deploys on merge (`run.mjs check-pr`: nothing deploys, see commands.log). Proven by its tests (real
git on temporary bare repositories, recording fakes of both APIs), the mutation check, `systemd-analyze verify` and the
read-only dry run of task B3 (AC-13).

Red on base: outputs/red-on-base.txt (first build, test file of that round, sha256 653e1775668d045e). On origin/main the
test file fails to load because the module does not exist (ERR_MODULE_NOT_FOUND, 1 of 1 failing); against a stub with
the same exported names and no behaviour, 49 of 49 tests fail.
Red, fix round 1: outputs/red-fix1.txt. The committed test file (sha256 9f94c4c48be6bec3) on the code of the reviewed
head 137d38dc: 54 tests, 47 pass, 7 fail: the 5 new tests and the 2 tests whose expectation changed (below).
Green: outputs/green.txt, 54 of 54 pass on Node 20.20.2 (UNIT.yml's version) and on Node 22.23.4.
Whole script set (UNIT.yml's command, no install): outputs/unit-all.txt, 34 files, 667 tests, 666 pass, 0 fail, 1 skipped
(a win32-only test in a file this lane does not touch), on Node 20.20.2 and Node 22.23.4.
Mutation check: outputs/mutation-check.txt (script outputs/mutation-check.sh): 25 deliberate changes of the bridge, one at
a time in a copy outside the worktree; 25 caught, 0 survived. Fix round 1 replaced the gate-order mutation (its line
changed) and added 9 (the three gate states, gate jobs read like any job, the non-success-first split, the order across
the tick, the rotation after a budget stop, the pending gate, the pending gate after a pipeline ended).
`systemd-analyze verify` (outputs/systemd-verify.txt) was not run again: fix round 1 does not change the units.

Advisory review (not the pipeline's reviewer-agent accept): a behavioural review by the `semantic_reviewer` agent of the
uncommitted lane found one high finding and sixteen others. Fixed and tested: the merge bot's merge of `main` was refused
and broke landing (now bridged; landing found from the merge request head); writes went on after a GitHub rate limit (now
paused); the status budget was spent in branch-name order on a clock hour (now gate jobs first, rotation, sliding hour);
merge requests of other accounts were rewritten (now never); ownership was lost with a deleted GitHub branch (now kept);
root-run dry runs and assist pushes could leave root-owned files in the service cache (now a throw-away repository);
`assist-push` took any ref (now only `refs/heads/assist/*`); git calls had no stall limit (now `http.lowSpeed*` and a
60-second ls-remote timeout); a missing token skipped silently (now `AssertPathExists`; the runbook writes the token file
only when the read worked); the fake GitLab moved closed merge requests and missing tests (added); the stale red-on-base
(re-recorded); fork names in the dry-run output (removed). Not code, listed below for the driver: the plan §2.2 / §3.13
conflict, the bridge's GitLab account, the push-identity check, PLAN-SPAR's status. (The no-pending-signal limit it
named was closed in fix round 1 by the pending `gitlab/gate`.)

Review round 1 (agent-vitana-lane-reviewer-202611050324-7146, `review: changes` on 45dcdf53), fixed on this head:
- Blocking, gate jobs' non-success results posted as success: fixed. `jobToStatus` (`:101-124`) gives `lane-scope`,
  `change-suite` and `gate` success only for `success`; the writes of a tick go non-success gate results first, then
  the other gate results, then the rest, across all pull requests (`:130`, `:976`). Tests "a failed check and a skipped
  gate give gitlab/gate failure…" (review ask a), "with a status budget of 1, GitHub never shows only success…" (ask b,
  with a second pull request first in the rotation), "jobToStatus: a landing gate job…" (ask c); AC-4 updated.
- Running pipeline shows only success (non-blocking): one pending `gitlab/gate` per head while the head pipeline has not
  ended and has no gate result (`:931-936`), counted in the budget, replaced by the real result. Test "while the head
  pipeline runs without a gate result…". A refused branch still gets no status (runbook "Limits").
- Timer enabled before the cut (non-blocking): the runbook states that the timer is installed but not enabled before the
  cut and how to check it; making M2's install leave it disabled is an open item below.
- Contract without `file:line` (non-blocking): added above, both sides.
- CI on 45dcdf53 not readable (non-blocking): all 11 check runs of 45dcdf53 finished `success` (among them `unit`,
  `pr-gate`, `Lane scope`, `Collab handoff`, `change-suite`; read with `gh api …/commits/<sha>/check-runs`). The new
  head gets its own run, and land-guard checks the merged head.
- Plan §2.2 / §8.1 step 4 against §3.13, the dry-run harness scope, the three cross-lane items: not changed here (the
  review says this lane should not change); listed under "Open items for the driver".

Decisions taken inside the plan (for Gate 2):
- Adoption: a GitLab branch at the GitHub head or at one of its ancestors is the same history and is adopted (M1's
  mirror copies every branch before the cut, so without it every open agent branch would be refused at the cut).
- The merge bot is not a second writer: a clean merge of `main` on top of the bridge's copy (two parents, the second on
  GitLab `main`, a tree equal to Git's automatic merge, as `collaboration.md` §3 defines a clean merge of main) keeps the
  branch bridged; its pipeline's results are posted on the pull request head; a new GitHub head replaces the merge.
- Only job results are posted, not "waiting" or "running" (each result is one write), plus, since fix round 1, one
  pending `gitlab/gate` per head while the pipeline runs. GitHub limits an account to about 80 content writes a minute
  and 500 an hour, so status writes are capped at 60 a tick and 450 in any hour, gate results that are not success
  first, with rotation; a rate limit pauses every GitHub write for at least a minute. The merge bot reads GitLab, so
  landing never waits for these statuses.
- The merge request body disarms GitLab quick actions with a backslash before a leading `/`, also inside code fences, so
  those lines differ from the pull request body; a draft pull request gets the title prefix `Draft:`.
- No merge request for forks, for head branches other than `kiro/*` and `claude/*`, or for bases other than `main`
  (the brief and plan §3.13; today 33 `pm-agent/*` pull requests and `i18n-db/artifacts`).
- The bridge never deletes a branch, never rewrites or closes a merge request another account opened, and does not open
  a new merge request for a head whose merge request a person closed.
- `assist-push` is stricter than a fast-forward: exactly one commit on top of the GitHub head, taken only from a
  protected `refs/heads/assist/*` ref, and only while GitLab has the bridge's copy.
- The bridge's GitLab account is not named by the plan: its token file is an option (`--gitlab-token-file`, default
  `/etc/vitana/gitlab-bridge-token`); the runbook states its rights (Developer on both projects: push to unprotected
  branches, create, update and close merge requests, read pipelines and jobs; scopes `api`, `write_repository`) and that
  the settings sync (lane `cutover` / M2 `settings`) creates it. `infra/gitlab-engineering/settings/**` is not edited.
- The GitHub token: fine-grained, Contents, Pull requests and Commit statuses read and write, both repositories; secret
  `vitana/engineering/gitlab/github-bridge-token` (named like M1's `github-mirror-token`), written to
  `/etc/vitana/github-bridge-token` mode 0600.
- systemd: `DynamicUser`, `LoadCredential` and `StateDirectory`, so no user and no install-script change are needed;
  dry runs and assist pushes read the service's cache through a throw-away repository and write none of its files.
- Fix round 1, gate states: a skipped gate job and a gate job that failed while allowed to fail are `failure`; an
  optional manual gate job is `pending` (it waits for a person, nothing failed); canceled stays `error` and an unknown
  status `pending`. Other jobs keep the merge bot's table unchanged.
- Fix round 1, order: the brief asks that "within a tick" non-success gate results go first, so the order runs across all
  pull requests of the tick, not only within one pull request: a head that showed green from an earlier pipeline gets its
  red gate before another pull request's green results. Statuses are collected while the repositories are read and posted
  after both (`postStatuses`); within a group the rotation order stays, so the pull request left without a turn still
  starts the next tick among the rest.
- Fix round 1, two existing tests changed their expectation, because their old expectation was the behaviour the review
  asked to change; neither lost an assertion. "statuses: one gitlab/<job>…": its running gate job now gives the pending
  `gitlab/gate`, so 9 statuses instead of 8, and the test also checks that status and its description. "the status
  budget goes first to the jobs that gate a landing…": in its second tick a's new pipeline is red while a's GitHub head
  shows only green, so a's two red gate results now go before b; b still goes first one tick later, among the rest, and
  a fourth tick checks a's last two results.
- Fix round 1, pending gate: posted while the head pipeline has not ended (`success`, `failed`, `canceled` and `skipped`
  end it) and has no settled gate job, so a pipeline that ended without a gate job adds nothing: after the merge bot's
  `ci.skip` train update (plan §3.5) GitHub keeps the tested head's result instead of turning pending. Its `target_url`
  is the pipeline page. The fake GitLab of the tests now derives a pipeline's status from its jobs, as GitLab does.

Open items for the driver (outside this lane's paths, not decided here):
- Plan §2.2 says the pull requests of the kept GitHub workflows (WHATS-NEW-DRAFT, I18N-DB-SEED, …) "go through the
  bridge"; §3.13, the task and the brief bridge only `kiro/*` and `claude/*`. Their branches (`whats-new/*`,
  `i18n-db/artifacts`) get no merge request today.
- No lane's tasks create the bridge's GitLab account and its token file.
- Bridged pushes reach GitLab as the bridge's account, so M2's review check "pushed by `agent-reviewer`" cannot hold for
  a bridged same-repo lane; lane `merge-queue` has to account for it.
- The bridge carries GitLab job results to GitHub, not GitHub's PLAN-SPAR run to GitLab (plan §3.5, plan merge requests).
- Plan §8.1 step 4 ("the statuses come back") needs a GitLab instance; the B3 dry run here is read-only and plans the
  merge requests only.
- The caller of `assist-push` and the ref the assist job writes its commit to belong to lane `merge-queue`.
- The timer must stay disabled until the cut: eng-gitlab-m2's `ops-install.sh` installs every unit in `host/units/*` by
  glob (eng-gitlab-m2 plan.md:118-120, :236) and `m2.sh install` sets up the timers (:277). Unless that install leaves
  `vitana-github-bridge.timer` disabled, the bridge starts before the cut as soon as both token files exist, next to the
  M1 mirror. Pin "install, do not enable" in M2 settings or lane `cutover`, or add a start condition the cut sets.
- A refused branch's pull request has no `gitlab/*` status (the fix-round-1 brief keeps this limit), and
  `plan-driver.mjs:195-200` reads no status as green. Two ways out, for the driver to choose: one status on a refused
  head (for example `gitlab/gate` `error` "Branch refused by the GitHub bridge"), or a reader that treats a missing
  `gitlab/gate` as pending after the cut.
- Seat: main's PM bookkeeping (#4688, 945755f0) reassigned this lane `exafy → exafyltd` ("stale_ready") while the lane
  was executing on its branch, and changed this lane file. The PR now conflicts with main, and once main is merged in,
  Lane scope trusts main's `seat: exafyltd` and refuses every lane-file commit of this session (seat `exafy`). Checked in
  a throw-away clone, not pushed. Main's lane file needs `seat: exafy` back, or the lane a new builder, before it lands.
