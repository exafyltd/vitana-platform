---
lane: memory-facts-supersede-merge
state: ready
next_actor: owner
depends_on: [orphan-analysis-and-quarantine]
executor: kiro
seat: hotmail
reviewer_seat: exafy
paths:
  - supabase/migrations/20261101041*.sql
  - supabase/tests/vtid_mt_data_cleanup_memfacts_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
updated: 2026-11-01T13:00Z
---
# Supersede-merge reassigned memory_facts — mt-data-cleanup (repo vitana-platform)

Plan: `.kiro/specs/mt-data-cleanup/plan.md` (authoritative) and the `memory-facts-supersede-merge` group of
`tasks.md` (tasks M1–M5, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

**Held:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID; it then flips `next_actor` to kiro.
Depends on `orphan-analysis-and-quarantine` (its reassignment must land first, so duplicate `(user_id, key)` facts
exist to merge).

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. **Kiro never runs SQL against any live system** —
pre/post/rollback-check SQL is delivered under `docs/validation/<vtid>/` for Claude. A database change is a migration
file in this PR. Work only inside the allowed paths; add this lane's own `docs/validation/<vtid>/` in the same PR.

Branch `kiro/mt-data-cleanup/memory-facts-supersede-merge`; PR title
`VTID-xxxxx (mt-data-cleanup/memory-facts-supersede-merge): …`; commit trailers `Collab-Session: <your kiro session
id>` and `Collab-Lane: mt-data-cleanup/memory-facts-supersede-merge`. When the PR is open: set `state: in-review`,
`next_actor: kiro` (reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T13:00Z · kiro-hotmail-202610151618-b437 · created → ready
Created with the spec shell (push-first). Held at `next_actor: owner` pending PLAN-SPAR VTID allocation.
