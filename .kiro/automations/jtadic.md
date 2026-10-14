# Kiro Web automation — seat `jtadic` (j.tadic@exafy.io) — VTID-05145 A1

This file IS the task of the Kiro Web automation for j.tadic@exafy.io. The automation's own task text in app.kiro.dev is only:

> Read .kiro/automations/jtadic.md in vitana-platform and follow it exactly.

Your area: **backoffice automation** (`docs/programs/areas.yaml`). You take only lanes whose lane file says `seat: jtadic`.

## Every run, in this order

0. **Find the two checkouts.** Kiro Web clones each selected repository into its own directory; do not assume the
   names. Locate them with `git -C <dir> remote get-url origin` (`…/exafyltd/vitana-platform` and `…/exafyltd/vitana-v1`)
   and use those paths wherever this file writes `vitana-platform` or `vitana-v1`.
1. **Load the project rules** — `.kiro/steering/vitana-load-project-rules.md`, then everything it lists
   (`.kiro/steering/vitana-kiro-notes.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/collaboration.md`). They are
   binding. You are the **implementer** (§7–§7a): you never allocate VTIDs, take a `_plan` claim, edit `handoff.md`,
   merge or approve a PR, dispatch a workflow, deploy, or write to Supabase/AWS or any live system — even if a
   credential would allow it. Never test against production.
2. **Session id:** `node scripts/collab/queue.mjs session-id --agent kiro --seat jtadic` → `kiro-jtadic-YYYYMMDDHHMM-xxxx`.
   Use it in every claim, commit trailer, lane log entry and PR body of this run.
3. **Read the queue** (both repos are checked out side by side):
   `node vitana-platform/scripts/collab/queue.mjs --repo vitana-platform --repo vitana-v1 --seat jtadic --json`
4. **Pick exactly one lane**: `seat: jtadic`, `next_actor: kiro`, state `ready` or `executing`, `blocked: false`, no
   claim holder — oldest `updated` first. **If there is none, stop now**: no branch, no commit, no PR, no comment.
5. **Claim it**: `node vitana-platform/scripts/collab/queue.mjs claim <slug>/<lane> --session <id> --repo <repo of the spec>`.
   - Refused (another session holds it) → take the next lane from step 4, or stop if none is left.
   - The sandbox cannot push the claim ref at all → continue; write "claim unavailable from Kiro Web" in the lane log
     (the `seat` field already makes the lane yours alone).
6. **Read** the spec (`handoff.md`, `tasks.md`, `requirements.md`, `design.md`) and the whole lane file with its log.
   Implement **only that lane**, only inside the files its tasks name. If the lane needs something you may not do
   (a VTID, a plan change, a migration apply, a live write), stop work and go to step 9 with `next_actor: claude` and the
   reason.
7. **Check locally** before pushing: the repo's lint, typecheck, unit tests and build for what you touched (vitana-v1:
   `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`; vitana-platform: the changed service's tests).
   Also `node vitana-platform/scripts/collab/queue.mjs validate --repo <repo> --base origin/main --head HEAD`.
8. **Commit and push** on branch `kiro/<slug>/<lane>` with these trailers on every commit:
   ```
   Collab-Session: <your session id>
   Collab-Lane: <slug>/<lane>
   ```
   Open (or update) the PR titled `<VTID> (<slug>/<lane>): <what>`; its body names your session id, what you did,
   what you checked, and anything left open.
9. **Hand back**: in `lanes/<lane>.md` set `state: in-review` (or keep `executing` if blocked), `next_actor: claude`,
   `claimed_by: <your id>`, `pr: <url>`, `updated: <now>`, and append a log entry
   `### <ISO time> · <your id> · <old state> → <new state>` with what you did and what the reviewer must look at.
   Commit it on the same branch with the same trailers and push.
10. **Release the claim** (`queue.mjs release <slug>/<lane> --session <id> --repo <repo>`) and **stop**. One lane per run.

Claude Code (and later the Project Manager) reviews, merges, watches staging and sends the owner Gate 2.

## Owner setup (once, in app.kiro.dev signed in as j.tadic@exafy.io)
1. Connect the GitHub repos `exafyltd/vitana-platform` and `exafyltd/vitana-v1`.
2. Automations → New: name "Vitana queue — backoffice automation", select both repos, schedule hourly on weekdays (cron
   `0 7-19 * * 1-5`, or whatever the owner prefers), task text: `Read .kiro/automations/jtadic.md in vitana-platform and follow it exactly.`
3. Enable it.
