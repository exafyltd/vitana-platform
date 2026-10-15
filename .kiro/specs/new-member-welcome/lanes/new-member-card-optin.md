---
lane: new-member-card-optin
state: ready
next_actor: kiro
vtid: VTID-05206
seat: exafyltd
area: frontend
depends_on: []
updated: 2026-10-15T13:00Z
---
# New-member card opt-in + feed source

Plan: `.kiro/specs/new-member-welcome/` — the plan block in `plan-sparring.md` and the lane section in `tasks.md` are
authoritative (requirements/design text that says "comment" or "backing post" is superseded; owner decision D2 = b: the
greeting is a private DM on explicit Send). VTID: VTID-05206 (allocated, `in_progress`/`approved` in the ledger).
Repo: vitana-v1 (+ migration). Tasks B1–B4 in `tasks.md` (no backing post, no `post_kind`).
Rules for the executor (collaboration §7a): no VTID allocation, no merge/approve/deploy, no Supabase/AWS writes — DB changes
are migration files in this lane's PR. Copy `.kiro/specs/new-member-welcome/plan-sparring.md` to
`docs/validation/VTID-05206/plan-sparring.md` in your PR and add `scope.json`, `acceptance.md` and `staging-tests.json` there.

## Log
### 2026-10-15T09:40Z · kiro-202610150924-9ecd · created → ready
Drafted. next_actor: claude (spar → Gate 1 → allocate VTID), then kiro executes.

### 2026-10-15T13:00Z · session_01LKkSBuw1tGgnKzjhfcmAxj · ready → ready (handed to Kiro)
Owner approved the plan at Gate 1; VTID VTID-05206 allocated. Lane handed to Kiro: `next_actor: kiro`, seat `exafyltd` (area `frontend`). Start by claiming the lane
(`queue.mjs claim new-member-welcome/new-member-card-optin --session <your id>`); respect `depends_on` — do not start before those lanes are `done`.
