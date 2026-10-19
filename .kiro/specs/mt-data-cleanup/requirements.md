# Requirements — mt-data-cleanup (WS2)

Program: `docs/MULTI-TENANT-PLAN.md` v5.1 §6 WS2 (owner-approved 2026-10-10; decision register at its end). This
spec is the Kiro-readable hand-off of the WS2 data-cleanup slice. It links the program's records instead of copying
them.

## Program position
- **Predecessors (done / in flight):** VTID-05147 (S-M membership/role lockdown), VTID-05149 (A: `tenants.is_default`
  /`is_platform`, signup default tenant, `TenantContext`, `ci_tenant_isolation_health()`), VTID-05150 (B), VTID-05151
  (C) — all in production (`docs/multitenancy/MIGRATION-QUEUE.md`). **mt-identity** (WS1) supplies the canonical
  `user_tenants` this spec reads; its `membership-unification` lane is a hard predecessor of this spec's lane 1.
- **Successor:** WS3 community isolation + Network layer (`mt-community-isolation`) relies on
  `profiles.tenant_id` being backfilled (R3) and the orphan rows resolved (R1) before it adds `tenant_id` + RLS to
  community tables.

## Goal
Resolve every orphan / mis-tenanted row left by the single-tenant era without ever remapping test data or ambiguous
rows to Maxina, snapshot everything before moving it, stop the legacy writers re-creating `…0001` rows, and pin
the hot tenant tables' existing `tenant_id NOT NULL` — all as DB migrations applied by Claude, with read-only counting SQL written for Claude to run
(Kiro never runs SQL).

## R1 — Orphan analysis, snapshot, remap and quarantine (lane `orphan-analysis-and-quarantine`)
1. WHEN cleanup begins THE SYSTEM SHALL first produce an **analysis split by column** (`tenant_id` class ×
   `user_id`/`sender_id` class) for every affected table, distinguishing `…0001`-as-dev-tenant from `…0001`-as-bot-user
   and the dev user `…0099`, before any row is moved (program §6; `orb-memory-bridge.ts:66-70`, `vitana-v1/.env:17`).
2. THE SYSTEM SHALL create a `bak_mt_data_cleanup_<table>` snapshot of every row it will move or delete, retained 30
   days, BEFORE any write (§4.7).
3. THE SYSTEM SHALL send every row owned by dev user `…0099` (all 1,067 `memory_facts` and its `memory_items`) to a
   quarantine table and SHALL NOT remap them to Maxina or any live tenant (program §6, explicit).
4. THE SYSTEM SHALL set bot-sent rows (`sender_id = …0001`) to the **recipient's** tenant (derived from the DM
   peer / group), never to the dev tenant and never to quarantine.
5. THE SYSTEM SHALL remap every remaining orphan row to its owner's **canonical primary `user_tenants`** tenant
   (mt-identity `membership-unification`).
6. WHEN a row's owner has **0 or 2+ memberships**, or a cross-tenant DM cannot be attributed, THE SYSTEM SHALL place
   the row in `mt_orphan_quarantine` with its source table, original values and a reason, and SHALL NOT default it to
   Maxina.
7. THE SYSTEM SHALL move rows in batches (1–5k/txn) under `lock_timeout` with retries, off-peak, and SHALL provide a
   pre-approved rollback migration that restores from the `bak_*` snapshot.
8. THE SYSTEM SHALL repoint every NULL-fallback writer function of the six migrations in plan premise 7 to the member's
   single primary `user_tenants` row, failing closed on 0/2+ primaries and never writing `…0001`, behind a
   precondition gate that aborts the apply if no primary membership row exists.

## R2 — memory_facts supersede-merge (lane `memory-facts-supersede-merge`)
1. AFTER R1 reassignment, FOR each `(user_id, key)` with more than one current fact THE SYSTEM SHALL keep the fact
   with the newest `extracted_at` current and mark the older ones superseded via the memory system's existing
   supersede mechanism, snapshotting first and providing a rollback that restores the snapshot.

## R3 — profiles.tenant_id backfill (lane `profiles-tenant-backfill`)
1. THE SYSTEM SHALL backfill `profiles.tenant_id` from each member's canonical primary `user_tenants` row; a member
   with 0 or 2+ memberships SHALL stay NULL and be listed for the R1 quarantine review, never defaulted to Maxina.
2. THE column SHALL stay nullable in this spec (NOT NULL on `profiles` is WS3/WS10 scope).

## R4 — assert and pin NOT NULL on the hot tables (lane `hot-tables-not-null-expand-contract`)
1. `chat_messages`, `user_notifications` and `product_analytics_events` already have `tenant_id NOT NULL` in their
   authoritative DDL (plan premise 5). THE SYSTEM SHALL ship an assertion-only migration that fails the apply loudly if
   any of those columns is nullable or holds a tenant id not in `tenants`; it SHALL NOT add a trigger, backfill,
   default or `SET NOT NULL`. If it ever fires, §4.7 expand/contract is re-planned in a new sparred plan.
2. THE SYSTEM SHALL record `tenant_id UUID NOT NULL` for these tables in `DATABASE_SCHEMA.md`.
3. THE SYSTEM SHALL run after R1 and R3 (its assertion includes their zero-orphan state); its rollback is a no-op.

## Non-functional (all lanes)
- Production is read-only for Kiro and every test (rules 31/31b/48); DB changes are migration files in the lane PR,
  applied by Claude. Read-only counting/verification SQL is delivered for Claude under `docs/validation/<vtid>/`.
- Test/service/platform accounts stay invisible to members (rules 43–45): quarantine must not surface a `…0099`/bot
  row into any live tenant's member-facing data.
- No AI call, no spoken wording, no i18n string, no new route — DB only.

## Not in this slice
mt-identity (dependency), the `DEV_IDENTITY`/slug-map CODE cleanup (mt-identity `tenant-db-and-slug-cleanup`), WS3
community `tenant_id`/RLS/`profiles.tenant_id NOT NULL`, purging the quarantine table (later owner-approved step).
