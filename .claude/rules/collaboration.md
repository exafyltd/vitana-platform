---
paths:
  - .kiro/specs/**
---

# Claude Code ↔ Kiro collaboration protocol (VTID-05145)

Owner decision 2026-10-13: Claude Code and Kiro IDE work as one team across hundreds of sessions, dozens of them in
parallel, **without the owner relaying anything between them**. Either agent writes plans; the other executes; the
other verifies. This file is identical in `exafyltd/vitana-platform` and `exafyltd/vitana-v1`; the Kiro twin is
`.kiro/steering/vitana-collaboration.md`. Sparring record: `docs/validation/VTID-05145/plan-sparring.md`.

## 1. Git is the only channel
A plan, a status change, a review or a result that is not pushed to `origin` does not exist. No chat relay, no
local-only notes, no copy-paste. A session that cannot push says so to the owner.

## 2. Where a plan lives
`.kiro/specs/<slug>/` in the repo where most code changes (plans that span both repos: `vitana-platform`):

| File | Written by | Content |
|---|---|---|
| `requirements.md`, `design.md`, `tasks.md` | the author | Kiro's spec format. Each task group in `tasks.md` carries `<!-- lane: <lane-id> -->`. |
| `handoff.md` | only the holder of the `_plan` claim (coordinator) | plan-level front matter + append-only log |
| `lanes/<lane-id>.md` | only the session holding that lane's claim (a reviewer may append a log entry) | lane front matter + append-only log |

`handoff.md` front matter:
```yaml
---
slug: <slug>                 # = folder name
author: claude | kiro
executor: claude | kiro
next_actor: claude | kiro | owner
state: drafted | sparred | approved | executing | in-review | verified | done | parked
parked_from: <state>         # only when parked
vtids: [VTID-xxxxx, ...]     # required from approved on
sparring_record: <path>      # required from sparred on
updated: 2026-10-13T10:00Z   # ISO; newest wins across branches
---
```
`lanes/<lane-id>.md` front matter:
```yaml
---
lane: <lane-id>              # = file name, lowercase-dashes
state: ready | executing | in-review | verified | done | parked
parked_from: <state>         # only when parked
next_actor: claude | kiro | owner
vtid: VTID-xxxxx             # required from executing on
depends_on: [<lane-id>, ...] # lanes that must be done first
claimed_by: <session id>     # the session working it
branch: <branch>
pr: <url>
updated: 2026-10-13T10:00Z
---
```
Log entries: `### <ISO time> · <session id> · <state change>` then what was done, PR/commit links, what the next
actor must do, open questions.

Plan transitions: `drafted→sparred→approved→executing→in-review→verified→done`, `in-review→executing`,
`sparred→drafted`. Lane transitions: `ready→executing→in-review→verified→done`, `in-review→executing`. Any
non-terminal state → `parked` (set `parked_from`), and `parked` returns only to `parked_from`. `done` is terminal.
A new plan starts at `drafted`, a new lane at `ready`.

## 3. Session identity — never mix sessions up
- Every session has one id and states it in its **first reply to the owner**, together with the lane it holds
  (or "no lane"):
  - Claude Code cloud session: its `session_…` id.
  - Kiro: `node <vitana-platform>/scripts/collab/queue.mjs session-id --agent kiro` → `kiro-YYYYMMDDHHMM-xxxx`,
    generated once at session start.
- Every commit of lane work carries the trailers
  `Collab-Session: <id>` and `Collab-Lane: <slug>/<lane-id>` (`<slug>/_plan` for coordinator commits).
  A reviewer appending to a lane log uses `Collab-Review: <slug>/<lane-id>` instead and changes no front matter.
- Branch per lane: `<kiro|claude>/<slug>/<lane-id>` (a cloud session whose branch name is assigned by the harness
  keeps it; the trailers then carry the match). PR title: `VTID-xxxxx (<slug>/<lane-id>): …`; PR body names the
  session id. **Match a PR to its lane only by these keys — never by recency or "the last thing Kiro did".**
- One VTID per lane (or per lane group the plan declares).

## 4. Session start
1. `git fetch --prune origin` in both checkouts.
2. Run the queue:
   `node <vitana-platform>/scripts/collab/queue.mjs --repo <vitana-platform> --repo <vitana-v1>`
   (one row per lane: state, next actor, claim holder, blocked, VTID, branch/PR, last log line;
   `--mine <session id>` shows what you hold).
3. Unless the owner gave you a different task, pick a lane whose `next_actor` is you, not `blocked`, not claimed,
   oldest `updated` first.

## 5. Claim before you touch anything
`node <vitana-platform>/scripts/collab/queue.mjs claim <slug>/<lane-id> --session <id> --repo <repo>`
pushes `refs/heads/collab-claim/<slug>/<lane-id>` without force. Git refuses it when another session holds the
lane → the script names the holder → **pick another lane, never work it in parallel**. Plan-level steps
(sparring, Gate 1, allocating VTIDs, `approved→executing`, `executing→…→done`, Gate 2) need the `_plan` claim.
- A session without a claim never edits `handoff.md` or a lane file.
- An owner instruction about a lane another session holds → tell the owner which session holds it and leave it.
- A claim older than 24 h with no new commit on the lane's branch may be broken:
  `release <slug>/<lane-id> --session <id> --stale`, and say so in the lane log.

## 6. Session end
Append your log entry, set `next_actor` / `state` (and `claimed_by`, `branch`, `pr`) in **your lane file** (the
coordinator: in `handoff.md`), commit with the trailers, push the branch / open or update the PR, then
`release <slug>/<lane-id> --session <id>` when you hand the lane to someone else.

## 7. Roles
- **Kiro authors → Claude executes:** Kiro pushes the spec as PR `plan(<slug>): …` with `handoff.md`
  (`author: kiro`, `state: drafted`, `next_actor: claude`) and its lanes (`ready`). Claude Code spars it (Kiro has
  no subagents), sends Gate 1, allocates VTIDs on "yes", then each lane runs on its own.
- **Claude authors → Kiro executes:** same, reversed; Claude sets `next_actor: kiro` on the lanes after Gate 1.
- Per lane, independently and in parallel: executor claims → implements → PR → `in-review`, `next_actor` = the
  other agent → reviewer checks the PR against `tasks.md` acceptance and CI, comments on GitHub, appends a review
  entry → `verified` → merge → `done`. Changes requested → `executing`, `next_actor` = executor.
- The coordinator moves the plan to `done` once every lane is `done` and sends Gate 2 when the release deploys.
- The owner is `next_actor` only at Gate 1, Gate 2 and the four Autonomy-Contract stop cases.
- Every existing rule is unchanged: sparring before a VTID, the two owner gates, never test against production,
  staging tests read-only.

## 8. Waking each agent
- Claude: the Routine whose prompt is `vitana-platform/scripts/collab/routine-prompt.md` (weekdays, 3×/day) works
  every lane with `next_actor: claude`, reviews open `executor:kiro` PRs, and cleans up claims.
- Kiro runs only on the owner's machine: the owner opens a session and types "continue"; the steering file makes it
  run §4.

## 9. CI
PR-GATE step **Collab handoff** (`queue.mjs validate`) checks every changed `handoff.md` / lane file, every state
change, and the session/lane trailers, and prints the queue in the job summary. Report-only until 2026-10-20, then
it counts toward the PR-GATE verdict.
