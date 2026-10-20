# Kiro Web automation — seat `exafy` (d.stevanovic@exafy.io) — VTID-05145 A1, roles VTID-05218, wake-ups VTID-05271

This file IS the task of the Kiro Web automation for d.stevanovic@exafy.io. The automation's own task text in app.kiro.dev is only:

> Read .kiro/automations/exafy.md in vitana-platform and follow it exactly.

Your area: **platform/DB + gateway services** (`docs/programs/areas.yaml`). You plan, build and review (`.claude/rules/collaboration.md` §7):
you build lanes with `seat: exafy`, you review lanes with `reviewer_seat: exafy`, and you answer the sparring of plans
with `author_seat: exafy`.

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
2. **Session id:** `node scripts/collab/queue.mjs session-id --agent kiro --seat exafy` → `kiro-exafy-YYYYMMDDHHMM-xxxx`.
   Use it in every claim, commit trailer, lane log entry and PR body of this run.
3. **Read the queue** (both repos are checked out side by side):
   `node vitana-platform/scripts/collab/queue.mjs --repo vitana-platform --repo vitana-v1 --json`
4. **Do at most ONE item, the first that applies, then stop.** If none applies, stop now: no branch, no commit, no PR,
   no comment. Starting or resuming a plan driver (W) is that one item.
   Order: W, A, B, C.
   - **W. Wake a driver**: an `approved` or `executing` plan whose `handoff.md` says `author_seat: exafy` and whose
     driver is not alive. Go to **Wake a driver (W)**.
   - **A. Answer a sparring round** of a plan you authored: an open PR titled `plan(<slug>): …` whose
     `.kiro/specs/<slug>/handoff.md` says `author_seat: exafy` and whose `sparring/` folder has a `round-<n>.md` (or
     `s<k>-round-<n>.md`) without the matching `responses` file. Go to **Planner**.
   - **B. Review a lane**: `reviewer_seat: exafy`, `state: in-review`, `next_actor: kiro`, no claim holder, in a plan
     with no alive driver. Go to **Reviewer**.
   - **C. Build a lane**: `seat: exafy`, `executor: kiro`, not `governance: true`, `next_actor: kiro`, state `ready` or
     `executing`, `blocked: false`, no claim holder, in a plan with no alive driver — oldest `updated` first. Go to
     **Builder**.

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
`author_seat: exafy`, `next_actor: kiro`), `tasks.md` and `lanes/*.md` (`ready`, each with `executor`, `seat` and
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

## Owner setup (once, in app.kiro.dev signed in as d.stevanovic@exafy.io)
1. Connect the GitHub repos `exafyltd/vitana-platform` and `exafyltd/vitana-v1`.
2. Automations → New: name "Vitana queue — platform/DB + gateway", select both repos, schedule hourly every day (cron
   `0 * * * *`; the plan drivers run 24/7, the automation is only their wake-up floor), task text: `Read .kiro/automations/exafy.md in vitana-platform and follow it exactly.`
3. Enable it.
