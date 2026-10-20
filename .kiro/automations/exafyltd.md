# Kiro Web automation — seat `exafyltd` (exafyltd@gmail.com) — VTID-05145 A1, roles VTID-05218

This file IS the task of the Kiro Web automation for exafyltd@gmail.com. The automation's own task text in app.kiro.dev is only:

> Read .kiro/automations/exafyltd.md in vitana-platform and follow it exactly.

Your area: **chat/messenger + general frontend** (`docs/programs/areas.yaml`). You plan, build and review (`.claude/rules/collaboration.md` §7):
you build lanes with `seat: exafyltd`, you review lanes with `reviewer_seat: exafyltd`, and you answer the sparring of plans
with `author_seat: exafyltd`.

## Every run, in this order

0. **Find the two checkouts.** Kiro Web clones each selected repository into its own directory; do not assume the
   names. Locate them with `git -C <dir> remote get-url origin` (`…/exafyltd/vitana-platform` and `…/exafyltd/vitana-v1`)
   and use those paths wherever this file writes `vitana-platform` or `vitana-v1`.
1. **Load the project rules** — `.kiro/steering/vitana-load-project-rules.md`, then everything it lists
   (`.kiro/steering/vitana-kiro-notes.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/collaboration.md`). They are
   binding (§7a, §7b). An automation run has no owner in the conversation, so it never merges: it stops at a green,
   reviewed PR (§7b needs an explicit per-PR owner instruction). Never allocate a VTID by hand, approve a PR on
   GitHub, dispatch a workflow, deploy (staging or production), review your own lane, or write to Supabase/AWS or any
   live system — even if a credential would allow it. Never test against production.
2. **Session id:** `node scripts/collab/queue.mjs session-id --agent kiro --seat exafyltd` → `kiro-exafyltd-YYYYMMDDHHMM-xxxx`.
   Use it in every claim, commit trailer, lane log entry and PR body of this run.
3. **Read the queue** (both repos are checked out side by side):
   `node vitana-platform/scripts/collab/queue.mjs --repo vitana-platform --repo vitana-v1 --json`
4. **Do at most ONE item, the first that applies, then stop.** If none applies, stop now: no branch, no commit, no PR,
   no comment.
   - **A. Answer a sparring round** of a plan you authored: an open PR titled `plan(<slug>): …` whose
     `.kiro/specs/<slug>/handoff.md` says `author_seat: exafyltd` and whose `sparring/` folder has a `round-<n>.md` (or
     `s<k>-round-<n>.md`) without the matching `responses` file. Go to **Planner**.
   - **B. Review a lane**: `reviewer_seat: exafyltd`, `state: in-review`, `next_actor: kiro`, no claim holder. Go to **Reviewer**.
   - **C. Build a lane**: `seat: exafyltd`, `next_actor: kiro`, state `ready` or `executing`, `blocked: false`, no claim
     holder — oldest `updated` first. Go to **Builder**.

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
repository). You never change the lane's state: Claude Code (later the Project Manager) sets `verified` from an
`approve` entry on the PR's current head and merges, or sends the lane back to `executing` on `changes`. Release the
claim. Stop.

### Builder (C)
5. **Claim it**: `node vitana-platform/scripts/collab/queue.mjs claim <slug>/<lane> --session <id> --repo <repo of the spec>`.
   Refused → the next lane, or stop. The sandbox cannot push the claim ref at all → continue and write "claim unavailable
   from Kiro Web" in the lane log.
6. **Read** the spec (`handoff.md`, `tasks.md`, `plan.md` or `requirements.md`/`design.md`) and the whole lane file.
   Implement **only that lane, only inside its `paths`** — the PR-GATE "Lane scope" check fails anything else. Need
   something you may not do (a VTID, a plan change, a migration apply, a governance path, a live write) → stop and go to
   step 9 with `next_actor: claude` and the reason.
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
9. **Hand over for review**: in `lanes/<lane>.md` set `state: in-review` (or keep `executing` if blocked),
   `next_actor: kiro` (the lane's `reviewer_seat` reviews it; `next_actor: claude` if blocked or `reviewer_seat: claude`),
   `claimed_by: <your id>`, `pr: <url>`, `updated: <now>`, and append a log entry
   `### <ISO time> · <your id> · <old state> → <new state>`. Commit it on the same branch with the same trailers and push.
10. **Release the claim** (`queue.mjs release <slug>/<lane> --session <id> --repo <repo>`) and **stop**.

The Project Manager (or, until it runs, Claude Code) merges verified lanes, watches staging and sends the owner Gate 2.

## Owner setup (once, in app.kiro.dev signed in as exafyltd@gmail.com)
1. Connect the GitHub repos `exafyltd/vitana-platform` and `exafyltd/vitana-v1`.
2. Automations → New: name "Vitana queue — chat/messenger + general frontend", select both repos, schedule hourly on weekdays (cron
   `0 7-19 * * 1-5`, or whatever the owner prefers), task text: `Read .kiro/automations/exafyltd.md in vitana-platform and follow it exactly.`
3. Enable it.
