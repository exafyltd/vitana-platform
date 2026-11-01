---
lane: tenant-db-and-slug-cleanup
state: ready
next_actor: kiro
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on:
  - helpers-and-policy-rewrite
paths:
  - services/gateway/src/services/tenancy/tenant-db.ts
  - services/gateway/src/services/tenancy/tenant-db.test.ts
  - services/gateway/src/services/tenancy/tenant-tables.ts
  - services/gateway/src/services/tenancy/is-health-table.ts
  - services/gateway/src/services/tenancy/is-health-table.test.ts
  - services/gateway/src/services/tenancy/health-db.ts
  - services/gateway/src/services/tenancy/tenant-context.ts
  - services/gateway/src/routes/me.ts
  - services/gateway/src/routes/dev-auth.ts
  - services/gateway/src/services/orb-memory-bridge.ts
  - services/gateway/src/routes/autopilot-prompts.ts
  - services/gateway/src/middleware/auth-supabase-jwt-repository.ts
  - services/gateway/src/routes/presence.ts
  - services/gateway/src/routes/presence-repository.ts
  - services/gateway/src/routes/presence-did-you-know.ts
  - services/gateway/src/routes/presence-did-you-know-repository.ts
  - services/gateway/test/mt-identity-slug-cleanup.test.ts
  - services/gateway/test/mt-identity-primary-tenant-readers.test.ts
  - services/gateway/test/mt-identity-tenant-slug-lookup.test.ts
  - services/gateway/test/mt-identity-presence-tenant.test.ts
updated: 2026-11-01T15:00Z
repos: [exafyltd/vitana-platform]
---
# tenant-db-and-slug-cleanup — tenantDb/TENANT_TABLES, canonical isHealthTable()/healthDb, slug cleanup (CODE)

Plan: `.kiro/specs/mt-identity-r2/plan.md` (authoritative) and the `tenant-db-and-slug-cleanup` group of `tasks.md`
(T1–T5, allowed paths, acceptance). Design: `design.md`. The VTID comes from PLAN-SPAR on convergence. This is a
gateway code lane for seat `jtadic`, and it depends on `helpers-and-policy-rewrite`.

Scope: gateway code, all dark behind `isMtResolutionV2Enabled()` (`services/mt-flags.ts:23`) /
`tenant_settings.feature_flags.mt.*`.
- The O1 interface: `type TENANT_TABLES`, `isHealthTable(tableName)`, `tenantDb(ctx)` and `healthDb(userId)`. Health
  tables are excluded from `TENANT_TABLES`. This file is the one source for the health list; other specs reference it.
- Remove the slug maps:
  - `routes/me.ts:15` `TENANT_SLUGS`, read at `:270,408`
  - `me.ts:23` `SLUG_TO_TENANT_ID`
  - `routes/dev-auth.ts:26` `SLUG_TO_TENANT_ID`, read at `:491`

  Add `bySlug` + `getTenantIdBySlug(slug)` to `tenant-context.ts` (`loadTenantFlags()` `:70`). `DEV_IDENTITY`
  (`services/orb-memory-bridge.ts:66`) takes its tenant from `DEV_TENANT_SLUG` (default `vitana`).
- R3-F1, `dev-auth.ts:364`: resolve the tenant as the body's `tenant_id`, then `DEV_TENANT_ID`, then
  `await getDefaultTenantId()`. If nothing resolves for a bootstrap role, return `503 REGISTRY_UNAVAILABLE` before
  `bootstrapRequestContext` and before the mint.
- Move the last `fetchPrimaryTenantForUser` callers to `resolvePrimaryTenant()`: `autopilot-prompts.ts:109`,
  `presence.ts:55` and `presence-did-you-know.ts:63`. The three repo fns become `@deprecated`.
- R3-F2: add `test/mt-identity-presence-tenant.test.ts`, one case per presence route, flag on and flag off.
- The literal lint and the ratchet (baseline 34 in 29 files on `62990ce285`, minus this lane's removals).

Rules (§7a): no VTID allocation, no merge outside §7b, no deploy and no live write. Add `docs/validation/<VTID>/`
(scope.json, staging-tests.json) in this PR. Branch `kiro/mt-identity-r2/tenant-db-and-slug-cleanup`. PR title
`VTID-xxxxx (mt-identity-r2/tenant-db-and-slug-cleanup): …`. Trailers `Collab-Session` +
`Collab-Lane: mt-identity-r2/tenant-db-and-slug-cleanup`.

## Log
### 2026-11-01T15:00Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-identity/tenant-db-and-slug-cleanup`. Answers R3-F1 (the dev-auth 503 guard) and R3-F2 (presence
tests). All cited sites were re-verified on `62990ce285`.
