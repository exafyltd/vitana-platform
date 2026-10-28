# Plan driver — Kiro Web (one continuous session) — VTID-05271

One driver per approved plan runs it 24/7, weekends included, from the `plan(` PR to Gate 2 (`.claude/rules/collaboration.md`
§8 and §8a). This file is the pipeline for **one Kiro Web session**. It needs no subagents to run: every step can run
in this session, one after the other. To go faster it may build up to 6 independent lanes at once with one builder
session per lane ("Parallel builders" below); the driver itself still reviews through the reviewer agent (step 4) and
lands one merge at a time, and the plan goes on without the reviewer agent when it cannot run.
Kiro IDE runs the same steps through `.kiro/workflows/vitana-pipeline.workflow.json` (lane `reviewer-agent`).

## Session start (Kiro Web)
From the workspace root, as the first action: `node vitana-platform/scripts/collab/kiro-web-session.mjs setup` (rules,
Kiro hooks, git hooks, dependencies, code intelligence, all in the foreground; give the tool call a timeout of at
least 15 min, about 8 min on a fresh sandbox; code intelligence runs last, so a timeout while it indexes leaves every
required item done and a later `setup` resumes it; `--no-codeintel` skips only the code-intelligence indexes). The git
`pre-commit` hook typechecks the gateway at commit time and the `pre-push` hook runs preflight on the commit being
pushed; never bypass either. A lane push before its PR exists carries the title and the PR body:
`PR_TITLE='VTID-xxxxx (<slug>/<lane>): …' PR_BODY_FILE=<file> git push …` (`kiro-web-session.mjs pr-body` writes a
body with the five VALIDATOR-CHECK declarations).

## Sequencing
- A dependent action goes in the **same** bash command as the action it depends on, chained with `&&`: `git commit … &&
  git push …`, `git worktree add … && <work in it>`, `git fetch … && git rev-parse …`.
- Independent actions are separate tool calls issued in one parallel batch (reads, tests of different files, reviews of
  different lanes).
- A tool call never shares a batch with the call whose result it needs (an edit and the commit of that edit, a push and
  the PR it opens): issue it in a later turn, after reading that result.
- After a push, `git ls-remote origin refs/heads/<branch>` must show the pushed sha before the next step uses it.

The rules of `.claude/rules/collaboration.md` (§2 spec layout, §5 claims, §7, §7a, §7b, §8, §8a) and `CLAUDE.md` Part 1
are binding. The owner is asked only at Gate 2, for an escalated sparring verdict and for the stop cases of §7, each with
the five-part stop message (what Kiro wants to do; why it is needed; impact and risk; the recommendation; the exact
yes/no decision needed). Git, push, PR, merges under §7b, re-runs, sparring rounds and VTIDs are never asked about.

## Inputs
- `<slug>` of the plan (`.kiro/specs/<slug>/` in the spec's repository) and your session id
  (`node vitana-platform/scripts/collab/queue.mjs session-id --agent kiro --seat <seat>`).
- Both checkouts, found by `git -C <dir> remote get-url origin` (`exafyltd/vitana-platform`, `exafyltd/vitana-v1`).
- How the driver was started: by an owner task (interactive) or by an automation's wake-up item W (automation-started).

## Heartbeat (plan §4.7)
- `node vitana-platform/scripts/collab/plan-driver.mjs heartbeat --slug <slug> --session <your id>` writes the next
  heartbeat on `refs/heads/collab-driver/<slug>`: a commit whose tree equals `origin/main^{tree}`, parent the previous
  tip (fast-forward only, never forced), trailers `Collab-Session: <your id>` and `Collab-Driver: <slug>`.
- Write one at start and then at most 15 min apart, also while waiting. The driver is **alive** while the tip's committer
  date is less than 45 min old; `plan-driver.mjs heartbeat-age --slug <slug>` prints the age in ms or `none`.
- Exit 3 = another driver is alive (a foreign tip younger than 45 min): you are not the driver; stop driving this plan.
  A foreign tip older than 45 min is taken over by the same command.
- Without `plan-driver.mjs` on `main` yet, write the same commit by hand: `git commit-tree origin/main^{tree} -p <tip>`
  with the two trailers, then `git push origin <sha>:refs/heads/collab-driver/<slug>` (no force; a rejected push means
  someone else moved the tip: re-read it and apply the 45 min rule).

## Resume
1. `git fetch --prune origin` in both checkouts. Read `handoff.md`, `plan.md`, `tasks.md`, every `lanes/*.md` and the open
   PRs of the plan (title `plan(<slug>)` or `VTID-… (<slug>/<lane>)`) with their check runs. Git is the state; nothing is
   kept in the session between wake-ups.
2. Hold the plan's `_plan` claim (`queue.mjs claim <slug>/_plan --session <your id> --repo <repo>`; §2: the handoff
   writer is the plan driver). Refused by a live holder → you are not the driver; stop.
3. Write the heartbeat, then run the loop.

## Loop (one action at a time, then the next)
`node vitana-platform/scripts/collab/plan-driver.mjs next --slug <slug> --repo vitana-platform --repo vitana-v1 --cap 6 --json`
returns the ordered actions (lane `pipeline-speed`, plan §5 H). Take the first one. Without the script, use the same order.
Preflight before every push of a `plan(` or lane branch: `node vitana-platform/scripts/collab/preflight.mjs --repo
<checkout> --base origin/main --head HEAD --branch <branch> --title "<PR title>"` runs every CI governance check
(Collab tests, `queue.mjs validate`, Lane scope, PR-GATE, Kiro steering) in one pass; fix every error it prints, re-run
until it passes, then push.
1. **Answer an open sparring round** (a `round-<n>.md` without its `responses` file): one disposition per finding,
   update the plan block, commit `responses-<n>.md` + `plan.md` on the `plan(` PR branch, run preflight, then push. PLAN-SPAR runs the next
   round. An escalated verdict is an owner stop. VTIDs come only from CI PLAN-SPAR after policy approval, never by hand.
2. **Merge the `plan(` PR** after convergence, under §7b, so the lanes read their files from `main`.
3. **Fix forward** a lane whose PR head has a failed check: read the log, fix inside the lane's `paths`, run preflight, then push. At most
   3 attempts per lane; the 4th failure parks the lane (`parked`, `parked_from`, `next_actor: owner`) with the
   five-part message. A failed PLAN-SPAR, PR-GATE or STAGING-VERIFY run on attempt 1 that failed for infra reasons may
   be re-run once (`collaboration.md` §7a re-run allowlist, matched on the workflow path).
4. **Review an `in-review` lane** with the reviewer agent `vitana-lane-reviewer` (model chain `claude-sonnet-5.5` →
   `claude-opus-5.5` → `claude-sonnet-4.5`), run as its own agent session on the PR's current head. Each review
   session's prompt starts with exactly `Reviewer chain model for this step: <model>. `, naming the chain model that
   session runs on (the line the agent's self-check keys on). Write its §4.2 verdict
   as the §4.1 review entry (trailers `Collab-Session`, `Collab-Review: <slug>/<lane>`, `Collab-Verdict`,
   `Collab-Reviewer: agent:vitana-lane-reviewer (<model it ran on>)`, `Collab-Reviewed-Head`). The driver never
   reviews a lane itself and never uses a model outside the chain: `model_unavailable` or a model failure → note the
   model as tried for that head, start the next review session on the next chain model at once, never wait or loop
   on one model (each model once per head); all three failed → one blocker, the lane is parked, go on with other
   actions. `changes` → the lane goes back to
   `executing` and its builder fixes every finding.
5. **Build a `ready` lane** whose `depends_on` lanes are `done`, up to 6 lanes `executing|in-review` per plan; two
   lanes on the same hot file never at once (§8a). Claim it, branch `kiro/<slug>/<lane>` from `origin/main`, write each
   new behaviour's test first and record it red on `origin/main`, implement only inside the lane's `paths`, run the
   checks of `tasks.md`, commit with `Collab-Session` / `Collab-Lane` trailers, run preflight, then push, open the PR
   `VTID-xxxxx (<slug>/<lane>): …`, set the lane `in-review`. Several independent `ready` lanes may be built at once,
   one builder session per lane ("Parallel builders").
6. **Land an accepted lane** under the §7b merge rule: accept on the current head, every check run green, up to date
   with latest `main` and re-checked on that head, no conflict, every `depends_on` lane done, target `main` with a
   staging-only deploy path. One merge per repo at a time. Record `merge: <sha>` and `authority: §7b PM rule` in the lane
   log. The Project Manager merges when it acts first.
7. **Watch staging** for a lane that deploys: STAGING-VERIFY on the merge commit. Failed → fix forward as a new lane
   added through `_plan` (a `done` lane is never reopened), at most 3, then park the plan with the five-part message.
8. **Gate 2** when every lane is `done` and STAGING-VERIFY passed on the last merge commit: *"Staging verified — ready for
   deployment to production?"* with the verified commit, the STAGING-VERIFY run link, test counts, every commit between
   production and it, the migrations in the release, "Decisions taken" and `docs/validation/<plan VTID>/timings.json`.
   The Project Manager posts it; an interactive driver also says it in the session. Production stays the owner's PUBLISH,
   or — when the owner explicitly commands it in an interactive session — the driver publishes itself under
   `collaboration.md` §7c (full, or only one session's changes). An automation-started driver never publishes.
9. **Done**: plan `done`, `_plan` claim released, and the heartbeat ref removed as the last action
   (`git push origin --delete refs/heads/collab-driver/<slug>`; it holds no work).
10. **Wait**: nothing to do now (checks running, review pending) → heartbeat, poll every 2–3 min, loop.

## Parallel builders
The driver may build up to 6 independent `ready` lanes at once (`collaboration.md` §8a caps and hot files unchanged:
two lanes on the same hot file or the same file are never dispatched together) by starting one builder agent session
per lane, all in one batch. Each builder:
- generates its own session id (`queue.mjs session-id --agent kiro --seat <lane seat>`) and claims its lane
  (`queue.mjs claim <slug>/<lane> --session <id> --repo <repo>`; refused by a live holder → it stops and says so);
- works only in its own worktree `<vitana-platform>/.agents/wt/<lane>` (`git worktree add … -b kiro/<slug>/<lane>
  origin/main`), follows `lane-code.md`, the Sequencing rules above and `common-rules.md`;
- pushes, opens its PR and returns `{lane, session, pr, head}`;
- never merges, never reviews or accepts, never edits `handoff.md` or another lane's file, never allocates a VTID.

The driver keeps the `_plan` claim, runs the reviewer agent per lane (reviews of different lanes may also run in
parallel, each its own session on its PR's current head) and lands one merge at a time under §7b. A push race between
builders (one shared object store) is fetched and retried up to 3 times (`common-rules.md` 8).

Builder prompt (one per lane; fill the `<…>`):

```text
You are the BUILDER session for lane `<slug>/<lane>` (<VTID>) in <owner/repo>. You are not the plan driver and not
the reviewer. Work autonomously. Main checkout: <vitana-platform> (never switch its branch). The plan is on
origin/main: .kiro/specs/<slug>/plan.md (your lane's section), tasks.md (your lane group and its Acceptance),
lanes/<lane>.md. Rules: .kiro/pipeline/common-rules.md, lane-code.md and driver.md "Sequencing" on origin/main.
Other builders work other lanes at the same time in their own worktrees; you share no file with them.
1. SID=$(node <vitana-platform>/scripts/collab/queue.mjs session-id --agent kiro --seat <seat>); claim
   <slug>/<lane> with it. Refused → stop and return {"lane":"<lane>","error":"claim refused: <holder>"}.
2. git -C <vitana-platform> fetch -q origin main && git -C <vitana-platform> worktree add -q -b kiro/<slug>/<lane>
   <vitana-platform>/.agents/wt/<lane> origin/main — all work there.
3. Tests first (red on origin/main, recorded in docs/validation/<VTID>/red-on-base.txt), then implement only inside
   the lane's paths; the lane's checks and evidence per lane-code.md; lane file state ready → executing with a log entry.
4. Commit (bot identity, Collab-Session + Collab-Lane trailers), write the PR body to a file
   (kiro-web-session.mjs pr-body …), then in a later call: PR_TITLE='<title>' PR_BODY_FILE=<file> git push … &&
   git ls-remote …; then open the PR and wait for its checks (kiro-web-session.mjs wait); fix forward at most 3 times.
Never: merge, review or approve, edit handoff.md or another lane's file, allocate a VTID, force-push, write to a live
system. Return only {"lane","session","pr","head","tests","checks"} as JSON.
```

## Automation-started driver (wake-up item W)
A driver started from an automation run never merges (steps 2 and 6 are left to the Project Manager or an
interactive driver; the lane stops at `verified`), never builds a governance lane or an `executor: claude` lane, and
stops when the run's time is almost up: last heartbeat, everything pushed, claims no longer needed released. The next
wake-up resumes from git.

## Never
Never allocate a VTID by hand, never deploy to production or dispatch a production workflow except an owner-commanded
publish in an interactive session (§7c), never run `publish-to-prod.sh`, never write to Supabase or any live system from a session tool (a database change is a migration
file in the lane's PR), never test against production, never skip, disable or loosen a test, never force-push, never
accept your own lane.
