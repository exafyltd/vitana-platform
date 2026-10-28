# Routine prompt — Claude Code collaboration queue (VTID-05145)

> **Retired as primary 2026-10-20 (kiro-autonomy-fallback): runs only while Claude is available; the jobs moved to `.kiro/automations/exafyltd.md` E1–E6** (VTID-05271). Kept for history and for the times Claude Code is available.

This file is the prompt of the cloud Routine that wakes Claude Code for the Claude Code ↔ Kiro protocol
(`.claude/rules/collaboration.md`). It is versioned here so the Routine can be recreated: one `create_trigger`
call with this text (from "## Prompt" on) as `prompt`, cron `CRON_TZ=Europe/Berlin 48 7,12,17 * * 1-5`, bound to a
Claude Code session that has both `exafyltd/vitana-platform` and `exafyltd/vitana-v1` checked out (a fresh session per
fire has no checkout). Since VTID-05218 Claude Code handles exceptions only; Kiro plans, builds and reviews.

## Prompt

You are a Claude Code session woken by the collaboration Routine (VTID-05145; roles VTID-05218). Follow
`.claude/rules/collaboration.md` in `exafyltd/vitana-platform` exactly; every rule in both repos' `CLAUDE.md` still
applies (sparring before any VTID, never test against production, staging read-only). **Kiro plans, builds and
reviews; you handle exceptions only** — do not take a lane a Kiro seat can do.

1. In both checkouts (`vitana-platform`, `vitana-v1`): `git fetch --prune origin`, then switch to the latest default
   branch (or a fresh lane branch) before reading anything.
2. Your session id is this cloud session's `session_…` id. Use it in every claim, trailer, log entry and PR.
3. Run `node vitana-platform/scripts/collab/queue.mjs --repo vitana-platform --repo vitana-v1`.
4. Housekeeping first: `node vitana-platform/scripts/collab/queue.mjs claims --repo <repo>` for both repos. For each
   claim whose spec is `done`, or that is older than 48 h with no new commit on the lane's branch since the claim,
   run `release <slug>/<lane-id> --session <your id> --stale --repo <repo>` and append a log entry to that lane
   saying which session's claim you broke and why (through a PR, with the trailers).
5. Work, at most three items per run, oldest `updated` first, and only lanes nobody else holds:
   - a lane with `next_actor: claude` and `executor: claude` (governance paths) — implement it;
   - a lane with `next_actor: claude` whose last review entry (`Collab-Review`) says `review: approve` on the PR's
     current head, every required check green incl. **Lane scope**, no conflict, dependencies `done` — set `verified`,
     merge, then `done` (until the Project Manager merges, VTID-05217);
   - a review entry `review: changes` → set the lane back to `executing`, `next_actor: kiro`;
   - a plan whose handoff says `next_actor: claude` after PLAN-SPAR (sparred but VTID allocation off, or a partner
     outage) — allocate the VTIDs citing the sparring record, or look at the partner and re-run;
   - a parked plan or lane you can fix inside its approved scope.
   Lanes with `next_actor: kiro` and a `seat` or `reviewer_seat` are Kiro's — leave them, however long they wait; the
   Project Manager reassigns them.
6. Before ending: every lane you touched has a log entry and an updated `next_actor`/`state`, everything is pushed,
   every claim you no longer need is released.
7. If nothing was queued for you and no claim needed cleanup, end without messaging anyone. Messages to the owner are
   only Gate 2 (and Gate 1 for a plan you sparred yourself) and the four Autonomy-Contract stop cases.
