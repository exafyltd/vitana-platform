# Kiro Web automation — seat `exafyltd` (exafyltd@gmail.com) — VTID-05145 A1, roles VTID-05218, wake-ups VTID-05271

This file IS the task of the Kiro Web automation for exafyltd@gmail.com. The automation's own task text in app.kiro.dev is only:

> Read .kiro/automations/exafyltd.md in vitana-platform and follow it exactly.

Your area: **chat/messenger + general frontend** (`docs/programs/areas.yaml`). You plan, build and review (`.claude/rules/collaboration.md` §7):
you build lanes with `seat: exafyltd`, you review lanes with `reviewer_seat: exafyltd`, and you answer the sparring of plans
with `author_seat: exafyltd`.

You are also the **exceptions seat** (`exceptions_seat: exafyltd` in `docs/programs/areas.yaml`): you do the jobs the
Claude Routine did (`scripts/collab/routine-prompt.md`, retired as primary), items E1–E6 below.

**An automation run is a fallback wake-up** (plan `kiro-autonomy-fallback`, VTID-05271). Every approved plan has one
continuous plan driver that runs it 24/7 (`.kiro/pipeline/driver.md`, `collaboration.md` §8). A run makes sure the
plans of this seat have a live driver, and otherwise does one small item.

## Every run, in this order

0. **Find the two checkouts.** Kiro Web clones each selected repository into its own directory; do not assume the
   names. Locate them with `git -C <dir> remote get-url origin` (`…/exafyltd/vitana-platform` and `…/exafyltd/vitana-v1`)
   and use those paths wherever this file writes `vitana-platform` or `vitana-v1`.
1. **Load the project rules** — `.kiro/steering/vitana-load-project-rules.md`, then everything it lists
   (`.kiro/steering/vitana-kiro-notes.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/collaboration.md`). They are
   binding (§7a). An automation run never allocates a VTID (CI PLAN-SPAR does), never merges or approves a PR on GitHub,
   never dispatches a workflow (the exceptions seat's re-run allowlist is the only workflow action), never deploys, never
   reviews its own lane, never applies a migration and never writes to Supabase/AWS or any live system — even if a
   credential would allow it. Never test against production. A database change is a migration file in the lane's PR.
2. **Session id:** `node scripts/collab/queue.mjs session-id --agent kiro --seat exafyltd` → `kiro-exafyltd-YYYYMMDDHHMM-xxxx`.
   Use it in every claim, commit trailer, lane log entry and PR body of this run.
3. **Read the queue** (both repos are checked out side by side):
   `node vitana-platform/scripts/collab/queue.mjs --repo vitana-platform --repo vitana-v1 --json`
4. **Do at most ONE item, the first that applies, then stop.** If none applies, stop now: no branch, no commit, no PR,
   no comment. Starting or resuming a plan driver (W) is that one item.
   Order: E1, W, E2, E3, E4, E5, E6, A, B, C.
   - **E1–E6. Exceptions** (this seat only): E1 is checked before W, E2–E6 after W. Go to **Exceptions (E1–E6)**.
   - **W. Wake a driver**: an `approved` or `executing` plan whose `handoff.md` says `author_seat: exafyltd`, or names
     an `author_seat` that has no `automation` in `docs/programs/areas.yaml` (for example `hotmail`), and whose driver
     is not alive. Go to **Wake a driver (W)**.
   - **A. Answer a sparring round** of a plan you authored: an open PR titled `plan(<slug>): …` whose
     `.kiro/specs/<slug>/handoff.md` says `author_seat: exafyltd` and whose `sparring/` folder has a `round-<n>.md` (or
     `s<k>-round-<n>.md`) without the matching `responses` file. Go to **Planner**.
   - **B. Review a lane**: `reviewer_seat: exafyltd`, `state: in-review`, `next_actor: kiro`, no claim holder, in a plan
     with no alive driver. Go to **Reviewer**.
   - **C. Build a lane**: `seat: exafyltd`, `executor: kiro`, not `governance: true`, `next_actor: kiro`, state `ready` or
     `executing`, `blocked: false`, no claim holder, in a plan with no alive driver — oldest `updated` first. Go to
     **Builder**.

### Exceptions (E1–E6)
Each E item is the run's one item. **Is Claude available?** Only the literal `false` of the repository variable means
unavailable (`gh variable get CLAUDE_AVAILABLE --repo exafyltd/vitana-platform`). Claude is also unavailable when the
oldest open item whose `next_actor` is `claude` (a lane or a `handoff.md`, state not `done`) has `updated` older than
4 h and no commit with a `Collab-Session: session_…` trailer newer than that item exists on `main` or on an open PR head
of either repo (plan `kiro-autonomy-fallback` §3). Without `gh` the 4 h rule decides alone. E3–E6 act on an item whose
`next_actor` is `claude` only while Claude is unavailable; E1 and E2 run always.
Legacy `executor: claude` lanes (governance paths) keep `next_actor: claude` while Claude is available; an automation run never builds them.
Before you write a lane file or a `handoff.md`, claim it (`queue.mjs claim`); release the claim when done.

- **E1. STAGING-VERIFY failed** on the merge commit of a lane of an `executing` plan (read-only:
  `gh run list --repo exafyltd/vitana-platform --workflow STAGING-VERIFY.yml --status failure --limit 20`; the run's
  `head_sha` is that merge commit and no later run on a newer commit passed).
  1. Infra failure (runner, Chromium install, timeout, staging not yet serving the commit) and attempt 1 → one re-run
     under the re-run allowlist below, log it in the lane log, stop.
  2. Otherwise append `fix-forward: <n>/3 <run url> <cause>` to the lane log (`n` = the number of `fix-forward:` lines
     of that plan since its last green STAGING-VERIFY, plus one) and wake the plan's driver (W for that plan, whatever
     its seat). A fix-forward is a new lane that the driver adds through the plan's `_plan`; a `done` lane is never
     reopened.
  3. The 4th failure of the same check → append the five-part stop message (what Kiro wants to do; why it is needed;
     impact and risk; the recommendation; the exact yes/no decision needed) to the lane log and wake the driver, which
     parks the plan (`parked`, `parked_from: executing`, `next_actor: owner`). A plan with `author_seat: exafyltd`
     you park yourself under its `_plan` claim.
- **E2. Stale claims** (one item, however many claims):
  `node vitana-platform/scripts/collab/queue.mjs claims --repo <repo>` for both repos. For every claim whose spec is
  `done`, or that is older than 24 h with no commit on the lane's branch since the claim (`collaboration.md` §5,
  `queue.mjs` `STALE_CLAIM_MS`), and whose plan has no alive driver:
  `queue.mjs release <slug>/<lane> --session <your id> --stale --repo <repo>`. Then one log entry per lane ("released
  the stale claim of <session>: <reason>"), one commit per lane with the trailers `Collab-Session: <your id>` and
  `Collab-Lane: <slug>/<lane>`, all in one PR per repo.
- **E3. Infra-escalated plan**: a `plan(` PR whose `handoff.md` last log entry is `escalated (partner unavailable)` with
  a reason in `RETRYABLE_REASONS` of `scripts/collab/plan-spar.mjs` (`model_unavailable`, `code_access_unavailable`,
  `deadline_exceeded`) → re-run the last failed PLAN-SPAR run of that PR under the re-run allowlist, at most once per
  24 h per plan, and comment `escalation retried: <run url>` on the PR (that comment is the 24 h counter). Any other
  reason → one PR comment `not retryable: <reason>`, once; leave it to the CI allocation retry or a successor plan.
- **E4. `review: changes` hand-back**: a lane in `in-review` whose last review entry says `review: changes` → set
  `state: executing`, `next_actor: kiro`, append a log entry, commit on the lane's branch, push.
- **E5. A lane whose `next_actor` is `claude`**, `executor: kiro`, no claim holder: claim it, read its last log entry,
  classify the reason, then:
  - no real blocker (capacity, a reassignment, a stale hand-off) → `next_actor: kiro` for its `seat` (no seat → build
    it under **Builder (C)**);
  - a VTID is missing → log once that CI PLAN-SPAR allocates it (E3 or the allocation retry), never by hand;
  - a migration apply, production or another stop case of `collaboration.md` §7 → `state: parked`, `parked_from`,
    `next_actor: owner` and the five-part stop message in the log;
  - a governance path → `next_actor: kiro` and the log line `interactive-only: governance lane` (an automation run
    never builds a governance lane).
- **E6. Parked items**: a lane parked after 3 failed CI fixes → as E5. A plan parked by PLAN-SPAR after its two
  sparring sessions → one PR comment `needs successor plan`, once (no third session exists, `plan-spar.mjs`
  `MAX_SESSIONS`). You never author another seat's plan.

**Re-run allowlist** (the only workflow action of an automation run, `collaboration.md` §7a): `gh run rerun <id> --failed`
only for a run whose `gh api repos/<owner>/<repo>/actions/runs/<id>` shows `path` `.github/workflows/PLAN-SPAR.yml`,
`.github/workflows/PR-GATE.yml` or `.github/workflows/STAGING-VERIFY.yml` in `exafyltd/vitana-platform`, or
`.github/workflows/PR-GATE.yml` in `exafyltd/vitana-v1`, `conclusion` `failure` and `run_attempt` 1. Match on `path`,
never on the display name. Never `gh workflow run`, never `gh pr merge` or `--admin`, never an `AWS-PROD-*` workflow,
never a deploy or migration workflow (`RUN-MIGRATION`, `apply-*`), never `apply_migration`, never PUBLISH and never
`publish-to-prod.sh`. No working `gh` in the sandbox → write `rerun unavailable from Kiro Web` in the lane log or PR
comment; for PLAN-SPAR push the next `responses` file when you author the plan, otherwise leave it to the plan's driver.

### Wake a driver (W)
A plan's driver is **alive** when `refs/heads/collab-driver/<slug>` exists in the spec's repository and its tip's committer
date is less than 45 min old: `node vitana-platform/scripts/collab/plan-driver.mjs heartbeat-age --slug <slug>` prints
the age in ms or `none` (without the script: `git ls-remote origin refs/heads/collab-driver/<slug>`, fetch that commit,
`git log -1 --format=%cI <sha>`). An automation run never takes a lane, a review or a sparring round of a plan whose
driver is alive.
1. Write the first heartbeat: `node vitana-platform/scripts/collab/plan-driver.mjs heartbeat --slug <slug> --session <your id>`.
   Exit 3 means another driver is alive → this item does not apply; go on with the next item.
2. You are that plan's driver now. Follow `.kiro/pipeline/driver.md` from **Resume** (resume from the git state: the
   handoff, the lane files, the open PRs and their checks) and keep the heartbeat at most 15 min apart.
3. A driver started from an automation run never merges and never builds a governance lane: it carries lanes up to
   `verified` and leaves the merge to the Project Manager or an interactive driver.
4. Before the run ends: a last heartbeat, everything pushed, claims you no longer need released. The next wake-up resumes.

### Planner (A)
Read the round file. For every finding decide: accepted (change `plan.md`), rejected (say why) or deferred (say where).
Write `sparring/<same prefix>responses-<n>.md` containing one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]` with
an entry for every finding; update the plan block in `plan.md`; commit both on the PR branch with
`Collab-Session: <your id>` / `Collab-Lane: <slug>/_plan`; push. PLAN-SPAR runs the next round. Stop.
A new plan (when the owner asked you for one): push `plan.md`, `handoff.md` (`state: drafted`, `author: kiro`,
`author_seat: exafyltd`, `next_actor: kiro`), `tasks.md` and `lanes/*.md` (`ready`, each with `executor`, `seat` and
`reviewer_seat` from `docs/programs/areas.yaml`, `paths`, `depends_on`) as PR `plan(<slug>): …`. No VTIDs — CI allocates them.

### Reviewer (B)
Claim the lane (`queue.mjs claim <slug>/<lane> --session <id> --repo <repo of the spec>`). Check the lane's PR(s)
against the lane's tasks in `tasks.md` and its acceptance: read the diff, run the repo's checks for what it touched,
read CI, the "Lane scope" check and `docs/validation/<VTID>/`. Comment on the PR with what you checked. Then append a
review entry to the lane file — `### <ISO time> · <your id> · review: approve` or `review: changes` plus your findings —
**without changing its front matter**, in one commit with the trailers `Collab-Session: <your id>` and
`Collab-Review: <slug>/<lane>`, pushed to the branch that carries the lane file (`kiro/<slug>/<lane>` in the spec's
repository). You never change the lane's state: the Project Manager (or the plan's driver under `collaboration.md` §7b)
sets `verified` from an `approve` entry on the PR's current head and merges, or sends the lane back to `executing` on
`changes`. Release the claim. Stop.

### Builder (C)
5. **Claim it**: `node vitana-platform/scripts/collab/queue.mjs claim <slug>/<lane> --session <id> --repo <repo of the spec>`.
   Refused → the next lane, or stop. The sandbox cannot push the claim ref at all → continue and write "claim unavailable
   from Kiro Web" in the lane log.
6. **Read** the spec (`handoff.md`, `tasks.md`, `plan.md` or `requirements.md`/`design.md`) and the whole lane file.
   Implement **only that lane, only inside its `paths`** — the PR-GATE "Lane scope" check fails anything else. Need
   something you may not do (a VTID, a plan change, a governance path) → stop and go to step 9 with `next_actor: kiro`
   and the reason (the exceptions seat picks it up, E5). A migration apply, production or another stop case of
   `collaboration.md` §7 → step 9 with `state: parked`, `parked_from`, `next_actor: owner` and the five-part stop message.
7. **Check locally**: the repo's lint, typecheck, unit tests and build for what you touched (vitana-v1: `npm run lint`,
   `npx tsc --noEmit`, `npm test`, `npm run build`; vitana-platform: the changed service's tests), then
   `node vitana-platform/scripts/collab/queue.mjs validate --repo <repo> --base origin/main --head HEAD` and
   `node vitana-platform/scripts/collab/queue.mjs scope-check --repo <repo> --base origin/main --head HEAD --branch kiro/<slug>/<lane>`.
8. **Commit and push** on branch `kiro/<slug>/<lane>` with these trailers on every commit:
   ```
   Collab-Session: <your session id>
   Collab-Lane: <slug>/<lane>
   ```
   Copy the plan's sparring record to `docs/validation/<VTID>/plan-sparring.md` and add `scope.json` + `acceptance.md`
   there. Open (or update) the PR titled `<VTID> (<slug>/<lane>): <what>`; its body names your session id, what you did,
   what you checked, and anything left open.
9. **Hand over for review**: in `lanes/<lane>.md` set `state: in-review` (or keep `executing` if blocked, `parked` for a
   stop case), `next_actor: kiro` (the lane's `reviewer_seat` reviews it; when blocked, the exceptions seat picks it up)
   or `next_actor: owner` for a stop case, `claimed_by: <your id>`, `pr: <url>`, `updated: <now>`, and append a log
   entry `### <ISO time> · <your id> · <old state> → <new state>`. Commit it on the same branch with the same trailers and push.
10. **Release the claim** (`queue.mjs release <slug>/<lane> --session <id> --repo <repo>`) and **stop**.

The Project Manager — or, while it is not `live`, an interactive plan driver under `collaboration.md` §7b — merges
verified lanes, watches staging and sends the owner Gate 2. An automation run never merges.

## Owner setup (once, in app.kiro.dev signed in as exafyltd@gmail.com)
1. Connect the GitHub repos `exafyltd/vitana-platform` and `exafyltd/vitana-v1`.
2. Automations → New: name "Vitana queue — chat/messenger + general frontend", select both repos, schedule hourly every day (cron
   `0 * * * *`; the plan drivers run 24/7, the automation is only their wake-up floor), task text: `Read .kiro/automations/exafyltd.md in vitana-platform and follow it exactly.`
3. Enable it.
