# Design — mt-identity (WS1 identity, tenancy resolution & roles)

## What exists (read these, do not copy them)
- Program plan + decision register: `docs/MULTI-TENANT-PLAN.md` (§4.2 resolution/hook, §4.3 policy classification,
  §4.4 tenantDb/TENANT_TABLES, §4.9 health exclusion, §4.7 migration protocol; N1/N2/N3; D14).
- Migration order, lane version ranges, apply status: `docs/multitenancy/MIGRATION-QUEUE.md` (latest applied row:
  VTID-05151 `20261014000700`).
- VTID-05149 already in production: `services/gateway/src/services/tenancy/tenant-context.ts`
  (`resolvePrimaryTenant(userId)` deterministic by `is_primary desc, created_at, tenant_id`; `TenantContext`;
  `getTenantMeta`); `middleware/auth-supabase-jwt.ts` (`getTenantContext`, `attachTenantContext`,
  `resolvePrimaryTenantForRequest`); `routes/universal-cart.ts:165` (`resolvePrimaryTenantId`). Records
  `docs/validation/VTID-05149/**`.
- `current_tenant_id()` helper: `supabase/migrations/20251229000000_vtid_01051_me_active_role_fix.sql:15` (reads JWT
  context; GRANTed to `authenticated`).
- Health-table policies already carrying `AND user_id = current_user_id()`:
  `supabase/migrations/20251231000000_vtid_01078_health_brain_phase_c1.sql` (lab_reports, biomarker_results,
  wearable_samples, health_features_daily, vitana_index_scores, recommendations, safety_constraints) — these are NOT
  among the bare policies.
- Slug maps / fake tenant ids to remove: `services/gateway/src/routes/me.ts:15-26`
  (`TENANT_SLUGS`/`SLUG_TO_TENANT_ID`, `…0001`→vitana, `…0002`→maxina), `services/gateway/src/routes/dev-auth.ts:26-29`,
  `services/gateway/src/services/orb-memory-bridge.ts` `DEV_IDENTITY` (`TENANT_ID`/`TENANT_SLUG` dev constants, ~lines 65-77).
- Forward reference confirming `tenantDb` does not exist yet:
  `services/gateway/src/middleware/auth-supabase-jwt-repository.ts:21` ("…moves with the other is_primary readers in
  the tenantDb slice").
- `bootstrap_admin_user` (to fix): vitana-v1 `supabase/migrations/20250831083908_…` through `20250831091149_…`
  (several copies) — pins `tenants.name IN ('Maxina','Alkalma','Earthlings')` / `name = 'Maxina'`, inserts into
  `memberships`.
- Health reader/writer modules that will route through `healthDb` later (first converts named in program §4.9; this
  spec only establishes the predicate + accessor): `services/gateway/src/routes/integrations.ts` (+ repository),
  `services/diary-health-extractor.ts`, `routes/health.ts`, `services/automation-handlers/health-wellness.ts`,
  `health-action-initiative.ts`.

## Design per lane

### helpers-and-policy-rewrite (DB)
`tenant_id_for_policies()` is a NEW function (never a redefine of `current_tenant_id()`); `is_member(tenant_id)` and
the N2 fallback share one lookup over the unique `(tenant_id, user_id)` index; both are called as `(select …)` so
Postgres evaluates them once per statement (initPlan). The bare-policy set, **recounted this review** (parser over all
668 `supabase/migrations/*.sql`, last-def-wins per policy name): **19 bare policies on 11 tables** — rewritten table by
table to the user-private or tenant-shared form:
- `community_groups` (`_insert`, `_update`, `_delete`), `community_meetups` (`_insert`, `_update`, `_delete`) — group
  objects: tenant-shared (`is_member`) read where appropriate, writer still user-scoped.
- `community_listings` (`_select_public`), `live_rooms` (`_select`, `_insert`, `_update`), `event_attendance`
  (`_select`), `live_highlights` (`_select`), `live_room_attendance` (`_select`) — tenant-shared or user-private per
  the row's ownership column.
- `products_catalog` (`_select`, `_insert`), `services_catalog` (`_select`, `_insert`),
  `tenant_catalog_overrides` (`_select`), `d42_domain_weights` (`_select`) — tenant-shared catalog reads.

The other program-listed tables are NOT in the rewrite: the 7 health tables already carry `AND user_id =
current_user_id()` (excluded via `isHealthTable()`); `tenants` (`USING(true)` public registry + service-role) and
`relationship_edges` (all guarded/service-role) carry no bare policy; and 5 tables have NO RLS policy at all —
`access_audit_log`, `consents`, `retrieval_traces`, `role_sessions`, `user_roles` — so there is nothing to rewrite and
creating net-new policies on them is WS2/WS10, out of scope here. A bare-policy lint (counts bare `current_tenant_id()`
policies outside an owner-tagged tenant-shared allowlist) must read 0 — the N3 gate for the later go-live. The executor
re-runs the recount at implementation and records the exact set in the PR; the number is a verified set, not a frozen
constant.

### membership-unification (DB)
`user_tenants` canonical; `memberships` → view + dual-write trigger; nightly drift report. Expand/contract; snapshot
before the data move; the backfill suppresses the four `user_tenants` AFTER INSERT triggers for its transaction (N1).

### access-token-hook-shadow (DB)
Hook function emits `tenant_id_shadow` only, fail-open, single indexed lookup, short statement timeout; mismatch-log
table for the soak. No auth-config change here. The go-live lane (owner-applied) is separate.

### role-source-and-bootstrap (DB)
Single role source of truth (proposed `user_tenants.active_role`; the open question is in plan.md); others derive.
`bootstrap_admin_user` rewritten to key on `tenants.is_default` and write canonical `user_tenants`.

### tenant-db-and-slug-cleanup (CODE, gateway)
`tenantDb(ctx)` wraps the service-role client and injects the tenant predicate for a schema-derived `TENANT_TABLES`.
`isHealthTable()` (ruling O1, canonical, defined here) excludes health tables from `TENANT_TABLES`; `healthDb(userId)`
reaches them keyed by user via the frozen home tenant. Slug maps replaced by `TenantContext` + the DB registry. All
reads dark behind the flags.

## Rules every successor follows
1. **Migrations:** apply strictly in `MIGRATION-QUEUE.md` order, one `RUN-MIGRATION.yml` dispatch per file, by Claude
   only, with read-only pre/post checks. New multi-tenant migrations take the next version in this spec's range
   (`20261101030000`–`20261101035959`) and are added to the queue in the same PR, after the VTID-05151 rows. A PR
   that adds a not-yet-live table/function adds it to `scripts/ci/migration-drift-baseline.json` and removes it after
   apply.
2. **Dark by default:** every merged CODE change is off unless enabled (`MT_RESOLUTION_V2`,
   `tenant_settings.feature_flags.mt.*`); the only exceptions are those the approved plan names (none in this spec).
3. **N3 ordering gate:** `current_tenant_id()` is NOT redefined here; the bare-policy lint must read 0 before any
   go-live lane redefines it. The hook stays shadow until a separate owner-applied lane (D14).
4. **O1 canonical `isHealthTable()`:** defined in this spec; other specs reference it and never keep their own list.
   Adding a health table extends this predicate here, with a stated dependency.
5. **VTID-05147 AC-5:** no later migration may grant members writes on `user_tenants` / role tables, recreate a
   dropped policy, or redefine `set_role_preference` without the membership check.
6. **Production is read-only** for every session and every test (CLAUDE.md 31–32, 48). The executor never writes to
   Supabase or AWS (collaboration §7a); a DB change is a migration file applied by Claude; the owner applies the auth
   hook.
7. Test/service accounts never visible to members (rules 43–45); i18n DE-first du-form; RTL via logical properties;
   Spotlight design contract; WCAG 2.2 AA; rule 41 (spoken strings model-composed).
