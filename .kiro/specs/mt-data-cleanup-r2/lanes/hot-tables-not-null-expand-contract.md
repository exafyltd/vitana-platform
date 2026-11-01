---
lane: hot-tables-not-null-expand-contract
state: ready
next_actor: kiro
depends_on: [orphan-analysis-and-quarantine, profiles-tenant-backfill]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102043*.sql
  - supabase/tests/vtid_mt_data_cleanup_notnull_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - DATABASE_SCHEMA.md
updated: 2026-11-01T15:30Z
repos: [exafyltd/vitana-platform]
---
# Assert and pin NOT NULL on the hot tables — mt-data-cleanup (repo vitana-platform)

Plan: `.kiro/specs/mt-data-cleanup-r2/plan.md` (authoritative) and the `hot-tables-not-null-expand-contract` group of
`tasks.md` (tasks H1–H6, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

Runs **last** in this spec: depends on `orphan-analysis-and-quarantine` and `profiles-tenant-backfill`, because its
assertion includes their zero-orphan state. **Assert-and-pin, no expand/contract** (sparring R1-F1/F2): `chat_messages`,
`user_notifications` (`20260225000000_notification_system.sql:27`) and `product_analytics_events`
(`20260612140000_BOOTSTRAP_product_analytics_events.sql:33`) are already `tenant_id NOT NULL` in DDL. Ship one
assertion-only migration (DO block that RAISEs if any of the three `tenant_id` columns is nullable or holds a tenant
id not in `tenants`) — no trigger, no backfill, no default, no `SET NOT NULL` — plus a no-op rollback file, and record
`tenant_id UUID NOT NULL` for these tables in `DATABASE_SCHEMA.md` (line ~2543 and the `user_notifications` entry). If
the assertion ever fires, stop: §4.7 expand/contract is re-planned in a new sparred plan, not improvised here.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. **Kiro never runs SQL against any live system** —
pre/post/rollback-check SQL is delivered under `docs/validation/<vtid>/` (RUN-MIGRATION checks). A database change is a migration
file in this PR. Work only inside the allowed paths; add this lane's own `docs/validation/<vtid>/` in the same PR.

Branch `kiro/mt-data-cleanup-r2/hot-tables-not-null-expand-contract`; PR title
`VTID-xxxxx (mt-data-cleanup-r2/hot-tables-not-null-expand-contract): …`; commit trailers `Collab-Session: <your kiro
session id>` and `Collab-Lane: mt-data-cleanup-r2/hot-tables-not-null-expand-contract`. When the PR is open: set
`state: in-review`, `next_actor: kiro` (reviewer seat `jtadic`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:30Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-data-cleanup/hot-tables-not-null-expand-contract`. Versions day-shifted to `20261102*`; WS1 dependency named `mt-identity-r2`;
executor and reviewer on today's §3a/§7 rules.
