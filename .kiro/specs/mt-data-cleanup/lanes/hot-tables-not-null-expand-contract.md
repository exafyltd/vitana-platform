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
  - DATABASE_SCHEMA.md
updated: 2026-11-01T13:00Z
---
# Assert and pin NOT NULL on the hot tables — mt-data-cleanup (repo vitana-platform)

Plan: `.kiro/specs/mt-data-cleanup/plan.md` (authoritative) and the `hot-tables-not-null-expand-contract` group of
`tasks.md` (tasks H1–H6, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

**Held:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID; it then flips `next_actor` to kiro.
Runs **last** in this spec: depends on `orphan-analysis-and-quarantine` and `profiles-tenant-backfill`, because its
assertion includes their zero-orphan state. **Assert-and-pin, no expand/contract** (sparring R1-F1/F2): `chat_messages`,
`user_notifications` (`20260225000000_notification_system.sql:27`) and `product_analytics_events`
(`20260612140000_BOOTSTRAP_product_analytics_events.sql:33`) are already `tenant_id NOT NULL` in DDL. Ship one
assertion-only migration (DO block that RAISEs if any of the three `tenant_id` columns is nullable or holds a tenant
id not in `tenants`) — no trigger, no backfill, no default, no `SET NOT NULL` — plus a no-op rollback file, and record
`tenant_id UUID NOT NULL` for these tables in `DATABASE_SCHEMA.md` (line 2542 and the `user_notifications` entry). If
the assertion ever fires, stop: §4.7 expand/contract is re-planned in a new sparred plan, not improvised here.

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
