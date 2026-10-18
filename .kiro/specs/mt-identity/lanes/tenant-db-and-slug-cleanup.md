---
lane: tenant-db-and-slug-cleanup
state: ready
next_actor: owner
depends_on:
  - helpers-and-policy-rewrite
executor: kiro
seat: jtadic
reviewer_seat: hotmail
paths:
  - services/gateway/src/services/tenancy/tenant-db.ts
  - services/gateway/src/services/tenancy/tenant-db.test.ts
  - services/gateway/src/services/tenancy/tenant-tables.ts
  - services/gateway/src/services/tenancy/is-health-table.ts
  - services/gateway/src/services/tenancy/is-health-table.test.ts
  - services/gateway/src/services/tenancy/health-db.ts
  - services/gateway/src/routes/me.ts
  - services/gateway/src/routes/dev-auth.ts
  - services/gateway/src/services/orb-memory-bridge.ts
  - services/gateway/test/mt-identity-slug-cleanup.test.ts
updated: 2026-11-01T00:00Z
---
# tenant-db-and-slug-cleanup — tenantDb/TENANT_TABLES, canonical isHealthTable()/healthDb, remove slug maps (CODE)

Plan: `.kiro/specs/mt-identity/plan.md`, `tasks.md` group `<!-- lane: tenant-db-and-slug-cleanup -->`. Design: `design.md`.

**Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. Depends on `helpers-and-policy-rewrite` (the DB
helpers the tenantDb predicates line up with). Gateway code lane — seat `jtadic` (uncovered platform gateway work,
per the brief's lane-assignment rule), reviewer `hotmail`.

Scope (gateway code, all dark behind `MT_RESOLUTION_V2` / `tenant_settings.feature_flags.mt.*`):
- `tenantDb(ctx)` — a service-role wrapper that injects the tenant predicate for a schema-derived `TENANT_TABLES`
  list; raw access stays only in allowlisted platform/cron code.
- The **canonical `isHealthTable()` predicate** (cross-spec ruling **O1**): health tables are EXCLUDED from
  `TENANT_TABLES` and reached only through a user-keyed `healthDb(userId)` that resolves the frozen health home
  tenant. This file is the single source other specs reference — they never keep their own list; adding a health
  table extends this predicate here.
- Remove the slug maps / fake tenant ids / `limit(1)` — each map holds four `…0001`–`…0004` ids
  (vitana/maxina/alkalma/earthlings), not two: `routes/me.ts:15` (`TENANT_SLUGS`, read at `me.ts:270,408`) +
  `routes/me.ts:23` (`SLUG_TO_TENANT_ID`), `routes/dev-auth.ts:26` (`SLUG_TO_TENANT_ID`, read at `dev-auth.ts:491`),
  `services/orb-memory-bridge.ts:66` `DEV_IDENTITY` (`TENANT_ID`/`TENANT_SLUG` at `:70-71`) — replace with the
  DB-backed registry / `TenantContext` (VTID-05149) and the canonical resolver.

Does NOT redefine `current_tenant_id()` and does NOT enable the hook (DB lanes own those). No new route → no
nav-registry / screen-manifest / parity-ledger change. New user-visible strings (none expected) would be i18n DE-first.

§7a: no VTID allocation, no merge/deploy, no live write. Add `docs/validation/<vtid>/` (scope.json, staging-tests.json)
in this PR. Branch `kiro/mt-identity/tenant-db-and-slug-cleanup`;
PR title `VTID-xxxxx (mt-identity/tenant-db-and-slug-cleanup): …`;
trailers `Collab-Session` + `Collab-Lane: mt-identity/tenant-db-and-slug-cleanup`.

## Log
### 2026-11-01T00:00Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-identity planner. Verified read-only: `tenantDb`/`TENANT_TABLES`/`isHealthTable`/`healthDb` do not
exist yet; slug maps live at the three cited sites. Held pending PLAN-SPAR VTID allocation.
### 2026-10-17T16:30Z · kiro-hotmail-202610151618-b437 · ready (round-2 premise tightening)
Re-verified the slug-map sites against platform tip e0ef609b: `me.ts:15` `TENANT_SLUGS` + `me.ts:23`
`SLUG_TO_TENANT_ID` (read at `me.ts:270,408`), `dev-auth.ts:26` `SLUG_TO_TENANT_ID` (read at `dev-auth.ts:491`),
`orb-memory-bridge.ts:66` `DEV_IDENTITY` (`:70-71`). Each map holds four `…0001`–`…0004` ids, not two; corrected the
citation. Paths unchanged.
