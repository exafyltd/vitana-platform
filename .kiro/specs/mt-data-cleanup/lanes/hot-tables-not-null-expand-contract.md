---
lane: hot-tables-not-null-expand-contract
state: ready
next_actor: owner
depends_on: [orphan-analysis-and-quarantine, profiles-tenant-backfill]
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101043*.sql
  - supabase/tests/vtid_mt_data_cleanup_notnull_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
updated: 2026-11-01T13:00Z
---
# NOT NULL on hot tables via §4.7 expand/contract — mt-data-cleanup (repo vitana-platform)

Plan: `.kiro/specs/mt-data-cleanup/plan.md` (authoritative) and the `hot-tables-not-null-expand-contract` group of
`tasks.md` (tasks H1–H6, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

**Held:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID; it then flips `next_actor` to kiro.
Runs **last** in this spec: depends on `orphan-analysis-and-quarantine` and `profiles-tenant-backfill` having resolved
the NULL `tenant_id` residue, so the §4.7 contract step can `SET NOT NULL` with no residual NULLs. `chat_messages`
(≈49k) and `user_notifications` (≈83k) are hot and browser/realtime-reachable — strictly expand/contract (BEFORE
INSERT backfill trigger → batched backfill → `CHECK … NOT VALID` → `VALIDATE` → `SET NOT NULL`), `lock_timeout` +
retries, off-peak. `product_analytics_events` gets an insert-time tenant default + the same CHECK→VALIDATE→SET NOT
NULL (no client RLS, so no policy rewrite); its default is never Maxina — payload tenant_id, else actor's resolved
tenant, else quarantine.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. **Kiro never runs SQL against any live system** —
pre/post/rollback-check SQL is delivered under `docs/validation/<vtid>/` for Claude. A database change is a migration
file in this PR. Work only inside the allowed paths; add this lane's own `docs/validation/<vtid>/` in the same PR.

Branch `kiro/mt-data-cleanup/hot-tables-not-null-expand-contract`; PR title
`VTID-xxxxx (mt-data-cleanup/hot-tables-not-null-expand-contract): …`; commit trailers `Collab-Session: <your kiro
session id>` and `Collab-Lane: mt-data-cleanup/hot-tables-not-null-expand-contract`. When the PR is open: set
`state: in-review`, `next_actor: kiro` (reviewer seat `jtadic`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T13:00Z · kiro-hotmail-202610151618-b437 · created → ready
Created with the spec shell (push-first). Held at `next_actor: owner` pending PLAN-SPAR VTID allocation.
