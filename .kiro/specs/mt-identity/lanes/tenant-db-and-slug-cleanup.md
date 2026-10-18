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
updated: 2026-10-17T17:20Z
---
# tenant-db-and-slug-cleanup — tenantDb/TENANT_TABLES, canonical isHealthTable()/healthDb, remove slug maps (CODE)

Plan: `.kiro/specs/mt-identity/plan.md`, `tasks.md` group `<!-- lane: tenant-db-and-slug-cleanup -->`. Design: `design.md`.

**Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. Depends on `helpers-and-policy-rewrite` (the DB
helpers the tenantDb predicates line up with). Gateway code lane — seat `jtadic` (uncovered platform gateway work,
per the brief's lane-assignment rule), reviewer `hotmail`.

Scope (gateway code, all dark behind `MT_RESOLUTION_V2` / `tenant_settings.feature_flags.mt.*`):
- The **O1 interface** (spelled out so downstream specs cannot drift): `type TENANT_TABLES` (schema-derived),
  `isHealthTable(tableName: string): boolean`, `tenantDb(ctx: TenantContext)`, `healthDb(userId: string)`. `tenantDb`
  is a service-role wrapper that injects the tenant predicate for `TENANT_TABLES`; raw access stays only in
  allowlisted platform/cron code.
- The **canonical `isHealthTable()` predicate** (cross-spec ruling **O1**): health tables are EXCLUDED from
  `TENANT_TABLES` and reached only through a user-keyed `healthDb(userId)` that resolves the frozen health home
  tenant. This file is the single source other specs reference — they never keep their own list; adding a health
  table extends this predicate here.
- Two distinct fake-id shapes (verified at tip e0ef609b): (a) two FOUR-entry slug maps `…0001`–`…0004` —
  `routes/me.ts:15` `TENANT_SLUGS` (read at `me.ts:270,408`) + `routes/me.ts:23` `SLUG_TO_TENANT_ID`,
  `routes/dev-auth.ts:26` `SLUG_TO_TENANT_ID` (read at `dev-auth.ts:491`) — plus the `limit(1)`, all REMOVED in favour
  of the DB registry / `TenantContext` (VTID-05149). (b) `services/orb-memory-bridge.ts:66` `DEV_IDENTITY` is a
  single dev-only fallback CONSTANT (user `…0099`) pinned to `TENANT_ID='…0001'`/`TENANT_SLUG='vitana'`, NOT a map and
  with no session to resolve — drive it from a `DEV_TENANT_SLUG` env var defaulting to `vitana` (DB-registry-backed in
  the sandbox), keep the pinned dev user. A Vitest lint asserts no `…0001` literal survives in gateway TS source
  outside exactly two intentional sites — `lib/vitana-bot.ts` (`VITANA_BOT_USER_ID`, the bot USER id, program §2) and
  `DEV_IDENTITY`'s resolved `DEV_TENANT_SLUG` default; the removed slug-map files are NOT exempt, so a partial removal
  fails the lint.

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
`orb-memory-bridge.ts:66` `DEV_IDENTITY` (`:70-71`). The two `me.ts`/`dev-auth.ts` maps hold four `…0001`–`…0004` ids.
Paths unchanged.
### 2026-10-17T16:55Z · kiro-hotmail-202610151618-b437 · ready (answered sparring s2 round-1)
Partner finding R1-F2 (major): `DEV_IDENTITY` is NOT a four-entry map — it is a single dev-user struct (`…0099`)
pinned to `…0001`/vitana. Corrected the scope split into (a) the two four-entry maps and (b) the `DEV_IDENTITY`
constant driven by `DEV_TENANT_SLUG` (default vitana). Added the O1 interface signatures (R1-F3). Paths unchanged.
### 2026-10-17T17:20Z · kiro-hotmail-202610151618-b437 · ready (answered sparring s2 round-2)
Partner finding R2-F1 (major): my `…0001` lint carve-out was both self-contradictory (exempting the slug-map files
lane 5a deletes = false safe harbour for a partial removal) and incomplete (omitting `lib/vitana-bot.ts:9`
`VITANA_BOT_USER_ID`, a legitimate bot USER id per program §2 / MULTI-TENANT-PLAN.md:28). Verified `vitana-bot.ts:9`.
Rewrote the lint to exempt exactly `lib/vitana-bot.ts` and `DEV_IDENTITY`'s resolved default, and to NOT exempt the
removed slug-map files. Paths unchanged.
