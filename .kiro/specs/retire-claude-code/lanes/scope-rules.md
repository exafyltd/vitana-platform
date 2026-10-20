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

### 2026-10-20T12:20Z · kiro-exafyltd-202610201041-ab5d · executing (fixes after the independent bypass review)
`semantic_reviewer` (round 1, changes) reproduced 8 bypasses. All 8 are fixed, and the reviewer's harness now shows
each one refused:
1. `_plan` commits on a governance lane PR are exempt only when they touch nothing outside `.kiro/specs/<slug>/`.
2. A `Collab-Review` commit may change only the lane file. A reviewer seat that built in the PR may not review.
3. A lane file new in the PR grants no governance path.
4. vitana-v1 cannot shadow a platform lane: when the lane is new locally, the vitana-platform copy is authoritative.
5. and 6. Removed the plan-author lane-edit exception (see Decisions).
7. `governanceRecord()` counts only new, quoted log lines below the front matter: placeholders, front-matter keys
   and older entries don't count. `merge:` must name a commit of the repo.
8. A legacy `reviewer_seat: claude` lane accepts a Kiro reviewer only when the lane names a `seat`, the reviewer seat
   differs from it, and that seat built nothing.

**Decisions** (narrower than plan Changes item 1; nothing grants more):
- Existing lanes' permission fields can no longer be changed by any `_plan` commit. PLAN-SPAR doesn't re-spar a
  converged plan (F6), so "changes plan.md" guaranteed nothing. A permission change is now a new lane in a new
  `plan(` PR.
- New `executor: claude` lanes are refused.

Tests: 39 pass (9 for VTID-05259). The 30 pre-existing tests are unchanged.
