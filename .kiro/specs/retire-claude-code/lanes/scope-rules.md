---
lane: scope-rules
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: jtadic
governance: true
paths:
  - scripts/collab/queue.mjs
  - scripts/collab/queue.test.mjs
  - docs/validation/VTID-*/**
updated: 2026-10-20T10:51Z
vtid: VTID-05259
---
# Lane scope rules: governance lanes, permission changes, legacy claude reviews (platform)
Plan: `.kiro/specs/retire-claude-code/` — `plan.md` and the `tasks.md` section `<!-- lane: scope-rules -->` are
authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
**Governance lane:** merge only on the owner's explicit per-PR instruction and an approving review from seat `jtadic` on the current head; never from an automation run.

## Log
### 2026-10-20T10:45Z · kiro-exafyltd-202610201041-ab5d · created → ready
Lane drafted with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat exafyltd claims it.

### 2026-10-20T10:51Z · ci-plan-spar · ready (VTID allocated)
VTID-05259 allocated after policy approval (converged-auto-v1).

### 2026-10-20T11:35Z · kiro-exafyltd-202610201041-ab5d · ready → executing
Built S1–S3 in `scripts/collab/queue.mjs`:
- `validateLane`: `governance: true` (true|false) is the only way a Kiro lane declares a governance path. It needs a
  `seat` and a `reviewer_seat` that is a Kiro seat ≠ `seat` (not `claude`). Seats existing in `areas.yaml` is already
  checked by `validateRegistry`. `executor: claude` lanes are unchanged.
- `validateRange`:
  - a governance lane needs an `owner-instruction:` log line to reach `verified`, and a `merge: <sha>` line to reach
    `done`. (Plan wording: both before verified/done. The merge SHA cannot exist before the merge, so it is checked at
    `done`. This is the conservative split, listed under Decisions);
  - a `_plan` commit by the plan's `author_seat` may edit an existing lane only if the same PR changes `plan.md`, and
    never its `state` or `claimed_by`.
- `scopeCheck`:
  - governance files are allowed only from `governance: true` lanes;
  - `governance` added to the permission fields a lane PR cannot change;
  - on governance lanes every build commit must name `seat` and every review entry `reviewer_seat` (unseated and
    `session_…` refused);
  - legacy `reviewer_seat: claude` also accepts a named Kiro seat ≠ `seat`.

Tests (`queue.test.mjs`): 36 pass. The 6 new tests fail on origin/main's `queue.mjs`; the 30 old ones pass on both.
`plan-spar.test.mjs` 10/10.
