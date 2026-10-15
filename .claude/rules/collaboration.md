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
| `plan.md` | the planner | the plan between `<!-- plan:begin -->` / `<!-- plan:end -->` (what PLAN-SPAR spars) |
| `sparring/` | PLAN-SPAR (`round-<n>.md`, `state.json`, `verdict.md`); the planner (`responses-<n>.md`) | the CI sparring record |
| `handoff.md` | only the holder of the `_plan` claim (coordinator), or PLAN-SPAR | plan-level front matter + append-only log |
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
executor: kiro | claude      # who builds it (VTID-05213)
seat: <seat>                 # the Kiro account that builds it (docs/programs/areas.yaml)
reviewer_seat: <seat>|claude # who reviews it — never the lane's own seat
paths:                       # the only files the lane may change (Lane scope); required from executing on
  - src/pages/messages/**
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

## 3a. Seats, areas and Kiro Web automations (VTID-05145 A1)
Owner decisions 2026-10-14: Kiro accounts are the development capacity (separate credits); each Kiro Web account
specialises in one area. All Kiro accounts share one GitHub identity (`exafyltd`), so GitHub labels or `/kiro`
comments cannot address one account — each account **pulls** its own work instead.
- **Seat** = one Kiro account, 1-12 lowercase letters (`jtadic`, `exafyltd`, `hotmail`, `exafy`), listed with its
  account and area in `vitana-platform/docs/programs/areas.yaml`. A seat's session ids are
  `kiro-<seat>-YYYYMMDDHHMM-xxxx` (`queue.mjs session-id --agent kiro --seat <seat>`).
- **Lane assignment:** whoever creates a Kiro lane (the `_plan` claim holder) sets `seat:` and `area:` in the lane file
  from the area map (most specific area wins; `frontend` is the catch-all). A lane without `seat:` can be taken by any
  Kiro session, as before.
- **Kiro Web automations:** each Kiro Web account has one scheduled automation whose task is only "Read
  `.kiro/automations/<seat>.md` in vitana-platform and follow it exactly." That file takes at most one lane with its own
  seat per run and stops at once when there is none. Change what an account does by editing its file, never in Kiro.
- `queue.mjs --seat <seat>` lists one seat's lanes; the queue table shows each lane's seat.
- **Lane fields (VTID-05213):** `executor: kiro|claude` (who builds it), `reviewer_seat` (who reviews it: another Kiro
  seat, never the lane's own `seat`, or `claude`) and `paths` (globs of the only files the lane may change; required once
  it is `executing`). The PR-GATE check **Lane scope** fails a lane PR that changes anything else, and any change to a
  governance path (`.github/**`, `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`,
  `CLAUDE.md`, `docs/programs/areas.yaml`) from a lane that is not `executor: claude`.

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
(sparring, Gate 1, allocating VTIDs, `approved→executing`, `executing→…→done`, Gate 2) need the `_plan` claim —
except what PLAN-SPAR does inside a plan PR (§7).
- A session without a claim never edits `handoff.md` or a lane file.
- An owner instruction about a lane another session holds → tell the owner which session holds it and leave it.
- A claim older than 24 h with no new commit on the lane's branch may be broken:
  `release <slug>/<lane-id> --session <id> --stale`, and say so in the lane log.

## 6. Session end
Append your log entry, set `next_actor` / `state` (and `claimed_by`, `branch`, `pr`) in **your lane file** (the
coordinator: in `handoff.md`), commit with the trailers, push the branch / open or update the PR, then
`release <slug>/<lane-id> --session <id>` when you hand the lane to someone else.

## 7. Roles
**Kiro plans, builds and reviews; the Project Manager merges and sends Gate 2; Claude Code handles exceptions**
(owner decisions 2026-10-14, Project Manager plan v2, VTID-05218 — replaces the VTID-05192 split). Kiro accounts carry
the work because each has its own credits.

- **Planning — either agent.** The owner gives an initiative to Claude Code or to a Kiro session; that agent is the
  planner. It pushes the spec as PR `plan(<slug>): …` with `plan.md` (the plan between `<!-- plan:begin -->` and
  `<!-- plan:end -->`), `handoff.md` (`state: drafted`, `author_seat` for Kiro) and its lanes (`ready`, each with
  `executor`, `seat`, `reviewer_seat`, `paths`, `depends_on`).
- **Sparring — CI.** `PLAN-SPAR.yml` spars every `plan(` PR through the gateway (Kiro holds no credential); the planner
  answers each round in `sparring/responses-<n>.md` and pushes. A converged plan is **approved by policy**
  (`converged-auto-v1`) — that replaces the owner's Gate 1 for it — and its lanes get their VTIDs. Not converged after
  the re-plan session → `parked`, on the board, no message. Claude Code may still spar its own plans with its local
  partner; the owner then answers Gate 1 as before.
- **Building — the lane's seat** (`executor: kiro`), or Claude Code for `executor: claude` lanes (governance paths).
- **Reviewing — the lane's `reviewer_seat`.** Per lane, independently and in parallel: executor claims → implements →
  PR → `in-review`, `next_actor: kiro` (the reviewer seat picks it up) → the reviewer checks the PR against `tasks.md`
  acceptance, CI and Lane scope, comments on GitHub and appends a review entry (`review: approve|changes`, commit
  trailer `Collab-Review`, front matter untouched) → the Project Manager (until it runs, Claude Code) sets `verified`
  from an `approve` entry on the PR's current head and merges, or sends the lane back to `executing`, `next_actor: kiro`.
- **Merging and Gate 2 — the Project Manager** (`services/gateway/src/services/project-manager/`, VTID-05216/05217) by
  rule: verified lane, review from `reviewer_seat` on the current head, every required check green incl. Lane scope,
  no conflict, dependencies done. Until it runs `live`, Claude Code merges a `verified` lane on the same rule.
- **Claude Code — exceptions only:** `executor: claude` lanes, lanes nobody picked up (reassigned to `claude`), parked
  plans and lanes it can fix, partner outages, and anything touching a governance path.
- The owner is asked only Gate 2 (and Gate 1 for a plan Claude Code sparred itself). Mid-flight stops (security or
  data-loss risk, a failure surviving 3 fixes) park the lane and show it on the board.
- Every existing rule is unchanged: sparring before a VTID, never test against production, staging tests read-only.

## 7a. What the executor and the reviewer never do
Applies to Kiro (as executor, reviewer or planner), and to Claude Code whenever it executes a lane. They never:
- allocate a VTID (CI and the coordinator do), take a `_plan` claim of a plan they did not author, or edit another
  lane's file;
- merge or approve a PR on GitHub (the Project Manager merges), dispatch a workflow, or deploy;
- review their own lane (a lane's `seat` never reviews it);
- writes to a live system, even though its credentials allow it: no Supabase writes (`execute_sql` with
  INSERT/UPDATE/DELETE/DDL, `apply_migration`, `deploy_edge_function`, branch/project/secret tools) and no mutating
  AWS call (ECS, ELB, ECR, IAM or Secrets Manager writes).

Reading for diagnosis is fine. A database change is a migration file in the lane's PR. Blocked → a log entry and
`next_actor: claude`, never a workaround.

## 8. Waking each agent
- Kiro Web seats: their scheduled automation (`.kiro/automations/<seat>.md`) does at most one item per run, in this
  order — answer a sparring round of a plan it authored, review one lane where it is `reviewer_seat`, build one lane of
  its seat.
- Claude: the Routine whose prompt is `vitana-platform/scripts/collab/routine-prompt.md` (weekdays, 3×/day) works only
  the exceptions in §7 and cleans up claims.
- Kiro runs when the owner starts it — in Kiro IDE on the owner's machine, or as a **Kiro Web** cloud session
  (app.kiro.dev) on `vitana-platform` — and types "continue"; the steering file makes it run §4. Kiro Web clones
  `exafyltd/vitana-v1` next to it (the Kiro GitHub app covers both repos) so `queue.mjs --repo … --repo …` works as in
  the IDE. If the session cannot get the second checkout, it runs `queue.mjs --repo <available repo>` only, works
  lanes in that repo, and leaves cross-repo lanes alone.

## 9. CI
PR-GATE step **Collab handoff** (`queue.mjs validate`) checks every changed `handoff.md` / lane file, every state
change, and the session/lane trailers, and prints the queue in the job summary. Report-only until 2026-10-20, then
it counts toward the PR-GATE verdict. The separate check **Lane scope** (`queue.mjs scope-check`, VTID-05213) is red on
its own when a lane PR leaves its `paths`. **PLAN-SPAR** (VTID-05214) spars `plan(` PRs; its commits carry
`Collab-Session: ci-plan-spar` and may move a plan from `drafted` to `sparred`, `approved` or `parked`.
