---
lane: supplier-relationships-db
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101120000_*_supplier_tenant_relationships.sql
  - supabase/migrations/20261101120100_*_products_distribution.sql
  - supabase/migrations/20261101120200_*_partner_tenant_backfill.sql
  - supabase/migrations/20261101120300_*_products_merchants_tenant_rls.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/vtid-*-supplier-tenant-relationships.test.ts
updated: 2026-10-15T17:05Z
---
# supplier-relationships-db — tenant↔supplier + offering distribution (VTID allocated by PLAN-SPAR, repo vitana-platform)

Plan: `.kiro/specs/mt-discover/plan.md` (authoritative) and the `supplier-relationships-db` group in `tasks.md`
(tasks D1–D6, allowed paths, acceptance). Design + successor rules: `design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID — PLAN-SPAR flips it to `kiro` itself. Without
the hold, another Kiro seat would build an unsparred lane with no VTID. Do not build until the VTID exists and the
state is `executing`.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes — the migration is a FILE in this PR; Claude applies
it via RUN-MIGRATION after merge. Work only inside the allowed paths. This lane adds its own
`docs/validation/<vtid>/` (migrations, rollback, `live-before.sql`, `post-apply-checks.sql`). Branch
`kiro/mt-discover/supplier-relationships-db`; PR title `VTID-xxxxx (mt-discover/supplier-relationships-db): …`;
commit trailers `Collab-Session: <your kiro session id>` and `Collab-Lane: mt-discover/supplier-relationships-db`.
When the PR is open: set `state: in-review`, `next_actor: kiro` (reviewer seat `jtadic`), `pr: <url>`, append a log
entry, release the claim.

Migrations in range 20261101120000–125959; renumber if a later migration exists at implementation; add MIGRATION-QUEUE
rows at the WS11 position (depends on A-M1 `tenants.is_default`/`is_platform` and mt-identity policy classification);
not-yet-live tables go in `scripts/ci/migration-drift-baseline.json`, removed in the PR after apply.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created, HELD at `next_actor: owner`. DB lane: `supplier_tenant_relationships`, `products.distribution`,
`partner_tenant.tenant_id` backfill, referral attribution column. Split from the gateway code lanes per §4.7.
Start by claiming (`node scripts/collab/queue.mjs claim mt-discover/supplier-relationships-db --session <id>
--repo <vitana-platform>`) once PLAN-SPAR has set the VTID and `executing`.

### 2026-10-15T17:05Z · kiro-hotmail-202610151618-b437 · sparring round-1 fixes (ready)
Round-1 findings R1-F2/R1-F3 (session `9ba4ff16`). The 4th migration is no longer a `product_orders.buyer_tenant_id`
column: D26 reuses the existing `product_orders.tenant_id UUID NOT NULL`
(`20260416120000_vtid_02000_marketplace_foundation.sql`), so the new column (NULL for all historical/new orders,
silent-fallback risk) is dropped (R1-F3). The 4th migration is now
`20261101120300_*_products_merchants_tenant_rls.sql`: it replaces `products_select`/`merchants_select` (today
`is_active = TRUE` only, `...foundation.sql:729/:735`) with tenant-scoped policies so RLS is a genuine backstop for
user-JWT reads (R1-F2), flag-guarded (inert for Maxina, D7). Path + task D4/D6 updated to match.

### 2026-10-21T14:10Z · kiro-hotmail-202610151618-b437 · spar session 2 round 1 (b452b935) — no path change
R2-F1: `product_orders.tenant_id` is nullable since VTID-04740 (`20260929120200…sql:12`); still no new column — D26
labels a NULL buyer tenant `anonymous_buyer` in the S4 code lane. R2-F3: `tenant_catalog_overrides` RLS cited (`:807-812`).

### 2026-10-21T14:25Z · kiro-hotmail-202610151618-b437 · spar session 2 round 2 — no path change
R3-F2: no mt-identity helper in the migrations — inline `user_tenants` EXISTS + existing `current_tenant_id()`; new
`discover_tenant_gate_enabled()` keeps the products/merchants RLS identical to today while the gate is off.
