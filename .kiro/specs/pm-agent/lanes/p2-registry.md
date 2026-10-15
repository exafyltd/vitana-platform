---
lane: p2-registry
state: ready
next_actor: kiro
vtid: VTID-05215
executor: kiro
seat: exafyltd
reviewer_seat: jtadic
depends_on: [p0-lane-scope]
paths:
  - docs/programs/*/program.md
updated: 2026-10-15T16:40Z
---
# P2 — programme registry content (VTID-05215)

Plan: `.kiro/specs/pm-agent/plan-sparring.md` (plan block authoritative) · tasks: `tasks.md` section `p2-registry`.
Executor: Kiro seat `exafyltd`; reviewer: Kiro seat `jtadic` (until P5 merges, Claude Code reviews and merges).
Start only when every `depends_on` lane is `done` (the queue shows `blocked` until then). Claim the lane, work on branch
`kiro/pm-agent/p2-registry`, change only files under `paths` (the PR-GATE "Lane scope" check fails anything else), copy
`plan-sparring.md` to `docs/validation/VTID-05215/plan-sparring.md` and add `scope.json` + `acceptance.md` there.
Never allocate a VTID, merge, deploy, or write to Supabase/AWS (collaboration §7a). Done → `in-review`,
`next_actor: claude`.

## Log
### 2026-10-15T16:40Z · session_01J2m8CtCfCH4VEGqmp6HrDh · created → ready
Created with the plan (Gate 1 yes 2026-10-15).
