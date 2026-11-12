# Multi-Tenant alignment: how the 18 workstreams consume the Multi-Tenant contracts

- **VTID:** VTID-05717, lane `mt-alignment` of plan `architecture-mt-alignment`
  (`plan-mt-align/.kiro/specs/architecture-mt-alignment/plan.md:63`,
  `plan-mt-align/.kiro/specs/architecture-mt-alignment/lanes/mt-alignment.md:17`).
- **Status of this document:** read-only record. It changes no code, schema, migration, flag, RLS policy, tenant,
  membership, provisioning step, MT spec or acceptance criterion (`plan-mt-align/.kiro/specs/architecture-mt-alignment/plan.md:19`).
  Every needed change is a proposed follow-up in §4, owned by an existing MT spec.
- **Pins:** vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835` (this worktree), vitana-v1
  `e31bf4627ff3c705c20f8e6b718ce4dd03353b7f` (`origin/main`), strategy repository `vitana/vitanaland-strategy` branch
  `kiro/phase-three-strategy` at `e5dd629d77a8e1032148e3c28688613924b6bd9c`. Plan branch
  `kiro/architecture-mt-alignment/plan` at `1723f77dd2960db4c689af4e6ae9f9dbe786ba83`. Wave-1 drafts (draft, not merged):
  destination identity VTID-05689 at `b8f4cb7f5f327c6f408b2544bb20da17c3a0fe17`, Healthy Million readiness VTID-05690 at
  `4502288c182e8acd1d659d3cab184bc004927461`.
- **Citation form:** a plain path is vitana-platform at its pin; `vitana-v1/…` is vitana-v1 at its pin;
  `vitanaland-strategy/…` is the strategy repository at its pin; `draft-05689/…` and `draft-05690/…` are the wave-1
  draft branches; `plan-mt-align/…` is the plan branch. `docs/validation/VTID-05717/check-citations.mjs` resolves every
  citation; its output is in `docs/validation/VTID-05717/commands.log`.
- **Live state:** nothing was read from a live database, auth config or production service. GitHub was read for open
  pull requests only (2026-11-11, before 11:56Z). Route-use counts below are `grep` line counts at the pin.

## Status-class legend

Every row carries exactly one class (`plan-mt-align/.kiro/specs/architecture-mt-alignment/tasks.md:10`).

| Code | Class | Meaning in this document |
|---|---|---|
| VO | Verified operational | Only with a run id. The run ids here are RUN-MIGRATION ids recorded in `docs/multitenancy/MIGRATION-QUEUE.md`; this lane did not re-read them (§5). |
| VI | Verified implemented, not operational | Present and wired at the pin. No run id was read that proves it runs in production, or it is merged but dark (flag off) or merged but not applied (queue row not applied). It does not claim the code is switched off. |
| II | Implemented but incomplete | Present at the pin, but partial compared with the target in `docs/MULTI-TENANT-PLAN.md` §4. |
| DN | Designed but not implemented | Specified in an MT spec or the MT plan; no code or migration file at the pin. |
| DS | Deprecated/superseded | Replaced by a later lane, spec or design. |
| UK | Unknown | Needs live state (§5). |

## 1. Multi-Tenant contracts at the pin

The "canonical" column names the one implementation every workstream must use. A workstream that needs the contract
calls it; it never builds a second one. Non-canonical copies that exist today are listed so nobody copies them again.

### 1.1 Tenant resolution (host, slug, token, membership → tenant)

| Contract | Where | Class | Canonical? |
|---|---|---|---|
| Target chain: host (`tenant_domains.host`) → path slug → JWT `tenant_id` claim → primary `user_tenants` row; unresolved is rejected | `docs/MULTI-TENANT-PLAN.md:52` | DN | Design source for every resolver below |
| Gateway primary-membership resolver `resolvePrimaryTenant(userId)`, deterministic order is_primary desc, created_at, tenant_id | `services/gateway/src/services/tenancy/tenant-context.ts:43`, query `services/gateway/src/services/tenancy/tenant-context-repository.ts:16` | VI | **Canonical gateway resolver** |
| Default tenant `getDefaultTenantId()` from `tenants.is_default` (60 s cache) | `services/gateway/src/services/tenancy/tenant-context.ts:101`, column `supabase/migrations/20261014000100_vtid_05149_tenants_default_platform_flags.sql:43` | VO (row 2, RUN-MIGRATION 38444968243, `docs/multitenancy/MIGRATION-QUEUE.md:19`) | Canonical "where new members land" |
| Token tenant: gateway reads `app_metadata.active_tenant_id` and checks membership (VTID-05043) | `services/gateway/src/middleware/auth-supabase-jwt.ts:283`, check `services/gateway/src/middleware/auth-supabase-jwt.ts:531` | VI | Canonical until the access-token hook goes live |
| Public slug registry `resolve_tenant(p_slug)` / `list_public_tenants()` over `_tenant_public_registry()` | `supabase/migrations/20261014000600_vtid_05151_public_tenant_registry.sql:133`, `supabase/migrations/20261014000600_vtid_05151_public_tenant_registry.sql:111`, `supabase/migrations/20261014000600_vtid_05151_public_tenant_registry.sql:41` | VO (row 7, RUN-MIGRATION 38457942567, `docs/multitenancy/MIGRATION-QUEUE.md:24`) | **Canonical anonymous slug → tenant** |
| Host + slug overload `resolve_tenant(p_host, p_slug)` over `tenant_domains` | `supabase/migrations/20261102140100_vtid_05507_mt_resolve_tenant_host.sql:40`, table `supabase/migrations/20261102140000_vtid_05507_mt_tenant_domains.sql:53` | VI (merged, rows 30-31 queued, `docs/multitenancy/MIGRATION-QUEUE.md:48-49`) | **Canonical host → tenant** once applied; gateway consumer is lane `host-resolution-gw` VTID-05502 (DN) |
| Policy resolver `tenant_id_for_policies()` (claim if member, else primary row) and `is_member(tenant_id)` | `supabase/migrations/20261102030000_vtid_05465_tenant_id_for_policies_is_member.sql:78`, `supabase/migrations/20261102030000_vtid_05465_tenant_id_for_policies_is_member.sql:61` | VI (rows 12-13 queued, `docs/multitenancy/MIGRATION-QUEUE.md:30-31`) | **Canonical RLS resolver** (N3: a new name, `current_tenant_id()` is not redefined in place) |
| Legacy `current_tenant_id()`: GUC, then top-level claim, then `app_metadata.active_tenant_id`, then `user_tenants` (repo body) | `supabase/migrations/20260218000000_fix_maxina_signup_tenant_association.sql:33` | UK (the MT plan says live reads only the top-level claim, `docs/MULTI-TENANT-PLAN.md:24`; the repo body reads more; VTID-05465 guards on the live body, `supabase/migrations/20261102030100_vtid_05465_bare_policy_rewrite.sql:12-13`) | Superseded by design (`tenant_id_for_policies()`); do not call in new policies |
| `caller_tenant_id()` second SQL resolver | `supabase/migrations/20260928200100_vtid_04718_overload_detection_data_layer.sql:18` | DS (to be folded in, `docs/MULTI-TENANT-PLAN.md:53`) | No |
| v1 static host map `DOMAIN_TENANT_MAP` (vitanaland.com and two subdomains → maxina), read by AuthGuard, guest auth and ShareEntry | `vitana-v1/src/config/domain-tenant-mapping.ts:5-8`, `vitana-v1/src/components/AuthGuard.tsx:75`, `vitana-v1/src/lib/guest-auth.ts:25`, `vitana-v1/src/pages/ShareEntry.tsx:25` | II | No: a second host map beside `tenant_domains` (follow-up F6) |
| Local per-user tenant lookups that bypass `resolvePrimaryTenant()` (10 repository functions; 3 read `app_users.tenant_id`) | `services/gateway/src/routes/memory-repository.ts:76`, `services/gateway/src/routes/relationships-repository.ts:34`, `services/gateway/src/services/data-export-consent-repository.ts:20`, `services/gateway/src/services/orb-tools/chat-privacy-tools-repository.ts:18`, `services/gateway/src/services/orb-tools/groups-events-tools-repository.ts:21`, `services/gateway/src/services/orb-tools/marketplace-va-shared-repository.ts:29`, `services/gateway/src/routes/health-repository.ts:68`, `services/gateway/src/routes/integrations-repository.ts:67`, `services/gateway/src/services/orb-tools/health-depth-tools-repository.ts:21`, `services/gateway/src/services/voice-tools/health-log-repository.ts:20` | II | No. The last four are inside `mt-native-health-r2` lane paths; the first six are in no lane (follow-up F1) |
| Memory diary fallback to the nil tenant `00000000-…0000` when no tenant resolves | `services/gateway/src/services/memory/diary.ts:29`, `services/gateway/src/services/memory/diary.ts:138` | II | No (follow-up F1) |

### 1.2 TenantContext (server and v1)

| Contract | Where | Class | Canonical? |
|---|---|---|---|
| `TenantContext { tenantId, slug, role, source, isPlatform }`, `TenantSource` = token, exafy_admin_token, primary, membership_fallback | `services/gateway/src/services/tenancy/tenant-context.ts:22-30` | VI | **Canonical server TenantContext** (target adds `settings`, `docs/MULTI-TENANT-PLAN.md:55`) |
| `req.tenant` set by `attachTenantContext`, lazily by `getTenantContext(req)` | `services/gateway/src/middleware/auth-supabase-jwt.ts:614`, `services/gateway/src/middleware/auth-supabase-jwt.ts:635` | VI | Canonical accessor |
| `tenantDb(ctx)` + `TENANT_TABLES`; `isHealthTable()` + `healthDb(userId)` | lane `.kiro/specs/mt-identity-r2/lanes/tenant-db-and-slug-cleanup.md:12-17`; "do not exist" `.kiro/specs/mt-identity-r2/plan.md:97` | DN | Canonical once built by VTID-05468 |
| Job context `JobTenantContext` per active tenant (`loadActiveTenantContexts`, `activeTenantIds`, `resolveJobTenants`) | `services/gateway/src/services/jobs/job-tenant-loop.ts:72`, `services/gateway/src/services/jobs/job-tenant-loop.ts:121`, `services/gateway/src/services/jobs/job-tenant-loop.ts:152` | VI (dark: needs `MT_RESOLUTION_V2` and `mt.jobs_tenant_loop`) | **Canonical job tenant loop** |
| v1 web `TenantProvider` / `useTenant()`: `app_metadata.active_tenant_id`, then URL slug, then stored slug; switch through `switch_to_tenant_by_slug` | `vitana-v1/src/hooks/useTenant.tsx:36-38`, `vitana-v1/src/hooks/useTenant.tsx:55`, `vitana-v1/src/hooks/useTenant.tsx:190` | VI | **Canonical web TenantContext** |
| v1 native `TenantProvider` (same RPCs: `list_public_tenants`, `switch_to_tenant_by_slug`) | `vitana-v1/apps/mobile/src/identity/TenantProvider.tsx:46`, `vitana-v1/apps/mobile/src/identity/TenantProvider.tsx:116`, `vitana-v1/apps/mobile/src/identity/tenant-registry.ts:19` | VI | Canonical native TenantContext; it reuses the DB registry, not a copy |
| v1 registry client `fetchTenantRegistry` / `fetchTenantBySlug`, `COMPILED_MAXINA_FALLBACK` safety net | `vitana-v1/src/lib/tenant-registry.ts:208`, `vitana-v1/src/lib/tenant-registry.ts:217`, `vitana-v1/src/lib/tenant-registry.ts:75` | VI | Canonical web registry client |

### 1.3 Membership and roles

| Contract | Where | Class | Canonical? |
|---|---|---|---|
| `user_tenants (tenant_id, user_id, active_role, is_primary)`, unique (tenant_id, user_id) | `supabase/migrations/20251231000000_vtid_01101_phase_a_bootstrap.sql:90` | VI | **Canonical membership store** (MT plan WS1, `docs/MULTI-TENANT-PLAN.md:108`) |
| Legacy `memberships` (role enum `tenant_role`) | `vitana-v1/supabase/migrations/20250831074859_3d469276-a217-499e-a67e-03e97240262c.sql:32` | II (becomes a view with dual-write, rows 14-16 queued, `docs/multitenancy/MIGRATION-QUEUE.md:32-34`) | No |
| Unification: backfill, `memberships` view + dual-write, drift report | `supabase/migrations/20261102031000_vtid_05466_user_tenants_canonical.sql:99`, `supabase/migrations/20261102031100_vtid_05466_memberships_view_dualwrite.sql:44` | VI (queued) | Canonical migration path |
| `user_permitted_roles` (granted roles) | `supabase/migrations/20260318100000_role_admission_system.sql:21` | VI | Canonical grant store |
| Single role source: `set_role_preference`, `me_set_active_role`, derive trigger | `supabase/migrations/20261102033000_vtid_05467_single_role_source.sql:95`, `supabase/migrations/20261102033000_vtid_05467_single_role_source.sql:170` | VI (rows 19-20 queued, `docs/multitenancy/MIGRATION-QUEUE.md:37-38`) | Canonical once applied |
| S-M membership role lockdown | `docs/multitenancy/MIGRATION-QUEUE.md:18` | VO (RUN-MIGRATION 38430363394) | — |
| Role catalogue `VALID_ROLES`, `SUPER_ADMIN_ONLY_ROLES` (developer, infra) | `services/gateway/src/constants/vitana-roles.ts:33`, `services/gateway/src/constants/vitana-roles.ts:37` | VI | Canonical role list |
| Role grant/revoke routes | `services/gateway/src/routes/role-admin.ts:123` | VI | Canonical |
| Self-join `switch_to_tenant_by_slug` (open_signup only) | `supabase/migrations/20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql:38` | VI (replacement for deactivated/archived tenants queued, row 33, `supabase/migrations/20261102070350_vtid_05493_mt_tenant_archive_switch.sql:106`) | **Canonical join/switch path** |

### 1.4 Authorisation helpers

| Contract | Where | Class | Canonical? |
|---|---|---|---|
| `requireTenant` (token tenant must be a membership; else primary row; 400 TENANT_REQUIRED) | `services/gateway/src/middleware/auth-supabase-jwt.ts:699` | VI (81 route uses) | **Canonical member + tenant guard** |
| `requireAuthWithTenant` (auth + tenant, parallel lookups) | `services/gateway/src/middleware/auth-supabase-jwt.ts:748` | VI (78 route uses) | **Canonical** |
| Membership check mode `TENANT_MEMBERSHIP_CHECK_MODE` (enforce unless `log`) | `services/gateway/src/middleware/auth-supabase-jwt.ts:528` | UK (deployed value not read) | — |
| `requireTenantAdmin` (exafy_admin bypass; JWT tenant must equal target; `active_role = admin` and admin in permitted roles) | `services/gateway/src/middleware/require-tenant-admin.ts:63`, `services/gateway/src/middleware/require-tenant-admin.ts:113`, `services/gateway/src/middleware/require-tenant-admin.ts:143` | VI | **Canonical tenant-admin guard** |
| `requirePlatformScope` (exafy_admin only for data with no tenant column: oasis_events, global_community_*, …) | `services/gateway/src/middleware/require-tenant-admin.ts:165-173` | VI | Canonical |
| `requireExafyAdmin` | `services/gateway/src/middleware/auth-supabase-jwt.ts:472` | VI | **Canonical exafy-admin guard** |
| Local `verifyExafyAdmin` copies (admin-tenants, admin-moderation, dev-access) | `services/gateway/src/routes/admin-tenants.ts:51` | VI | No (route-local copies) |
| `canManageRoles` (exafy_admin, or `active_role = admin` + same tenant; no permitted-role check) used by role-admin and backoffice-access | `services/gateway/src/lib/tenant-role-auth.ts:79`, `services/gateway/src/lib/tenant-role-auth.ts:89` | II (differs from `requireTenantAdmin` step 6; follow-up F3) | No |
| `provision_tenant()` refuses a non-exafy_admin `p_invited_by` | `supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql:105` | VO (row 6) | Canonical DB guard |

### 1.5 RLS policies and the tenant tables they cover

| Contract | Where | Class | Canonical? |
|---|---|---|---|
| Target classification: user-private, tenant-shared (`is_member`), admin-only; RLS mandatory on browser/realtime tables | `docs/MULTI-TENANT-PLAN.md:54` | DN | Design source |
| Bare-policy rewrite: 32 policies on 15 tables move from `current_tenant_id()` to `(select tenant_id_for_policies())` (community_groups, community_meetups, community_listings, d42_domain_weights, event_attendance, live_highlights, live_room_attendance, live_rooms, products_catalog, services_catalog, tenant_catalog_overrides, match_targets, relationship_nodes, …) | `supabase/migrations/20261102030100_vtid_05465_bare_policy_rewrite.sql:1-9`, policies from `supabase/migrations/20261102030100_vtid_05465_bare_policy_rewrite.sql:159` | VI (rows 12-13 queued) | **Canonical rewrite**; no other spec may rewrite these policies |
| `user_tenants` select-own policy | `supabase/migrations/20251231000000_vtid_01101_phase_a_bootstrap.sql:111` | VI | — |
| `tenants` readable by every authenticated user | `supabase/migrations/20251231000000_vtid_01101_phase_a_bootstrap.sql:44-45` | VI | — |
| Products/merchants tenant gate policies, inert until `mt.discover_tenant_gate` (NULL tenant: on if any tenant is on) | `supabase/migrations/20261102120300_vtid_05488_products_merchants_tenant_rls.sql:89`, `docs/multitenancy/MIGRATION-QUEUE.md:47` | VI (row 29 queued) | Canonical Discover RLS |
| Moderator tenant-scope policies, inert until `mt.moderator_tenant_scope` | `supabase/migrations/20261102070600_vtid_05491_mt_moderator_tenant_scope.sql:76`, `docs/multitenancy/MIGRATION-QUEUE.md:54` | VI (row 36 queued) | Canonical moderation RLS |
| `chat_messages.scope` + lockdown; `send_message()` binds sender to `auth.uid()` | `supabase/migrations/20261102050100_vtid_05576_send_message_rpcs.sql:162`, `docs/multitenancy/MIGRATION-QUEUE.md:63-65` | VI (rows 45-47 queued) | Canonical messenger write path |
| Production isolation monitor `ci_tenant_isolation_health()` (service_role) | `supabase/migrations/20261014000300_vtid_05149_ci_tenant_isolation_health.sql:20`, `supabase/migrations/20261014000300_vtid_05149_ci_tenant_isolation_health.sql:127` | VO (row 4, RUN-MIGRATION 38450645927, `docs/multitenancy/MIGRATION-QUEUE.md:21`) | **Canonical isolation monitor**; per-tenant variant row 62 queued (`supabase/migrations/20261102141100_vtid_05506_mt_isolation_health_by_tenant.sql:19`) |
| Live count of bare policies, tables without a tenant policy | `docs/MULTI-TENANT-PLAN.md:24` (2026-10-10 snapshot) | UK | — |

### 1.6 Provisioning (RPCs, admin routes)

| Contract | Where | Class | Canonical? |
|---|---|---|---|
| `provision_tenant(p_slug, p_name, p_admin_email, …)`, SECURITY DEFINER, service_role only | `supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql:55`, `supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql:242-243` | VO (row 6, RUN-MIGRATION 38455354298, no tenant created, `docs/multitenancy/MIGRATION-QUEUE.md:23`) | **Canonical provisioning RPC** |
| ERP bootstrap request inside `provision_tenant()` (same signature) | `supabase/migrations/20261102141000_vtid_05506_mt_provision_erp_request.sql:26` | VI (row 61 queued, `docs/multitenancy/MIGRATION-QUEUE.md:77`) | Replaces the row-6 body when applied |
| Admin API `/api/v1/admin/tenants`: list, detail, POST provision, PATCH brand pack, PUT assets, GET readiness (exafy_admin) | `services/gateway/src/routes/admin-tenants.ts:317`, `services/gateway/src/routes/admin-tenants.ts:388`, `services/gateway/src/routes/admin-tenants.ts:536`, RPC call `services/gateway/src/routes/admin-tenants-repository.ts:60`, mount `services/gateway/src/index.ts:1450` | VI | **Canonical provisioning route** |
| Reserved slugs (gateway list, DB table, v1 generated copy) | `services/gateway/src/services/tenant-provisioning/reserved-slugs.ts:29`, `supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql:129`, `vitana-v1/src/lib/tenant-registry.ts:151` | VI | Canonical source = `reserved_tenant_slugs` table; the others are generated mirrors |
| Readiness computation | `services/gateway/src/services/tenant-provisioning/readiness.ts:23` | VI | Canonical |
| Tenant-admin invitations (`requireTenantAdmin`) | `services/gateway/src/routes/tenant-admin/invitations.ts:42` | VI | Canonical invite path |
| Deactivate / archive tenant | `supabase/migrations/20261102070300_vtid_05493_mt_tenant_deactivate.sql:47` | VI (rows 32-33 queued) | Canonical lifecycle |
| Tenant pack intake + launch readiness | `supabase/migrations/20261101110000_mt_launch_tenant_pack_intake.sql:31`, `supabase/migrations/20261101110100_mt_launch_tenant_content_pipeline.sql:74` | VI (rows 9-10 pending, `docs/multitenancy/MIGRATION-QUEUE.md:27-28`) | Canonical pack intake |
| Signup default tenant (`handle_new_user`, `tenants.is_default`) | `supabase/migrations/20261014000200_vtid_05149_signup_default_tenant.sql:61` | VO (row 3, RUN-MIGRATION 38446340122) | Canonical |
| v1 exafy-admin "New community" panel | lane `.kiro/specs/multi-tenant/lanes/provisioning-ui.md:3`, PR vitana-v1 #1438 (open) | DN on main | Consumes the admin API above |

### 1.7 Tenant-aware memory

| Contract | Where | Class | Canonical? |
|---|---|---|---|
| Fact write path `rememberFact()` → `write_fact` RPC with `p_tenant_id` | `services/gateway/src/services/memory/remember.ts:139`, `services/gateway/src/services/memory/remember.ts:85` | VI | **Canonical memory write** (`services/gateway/src/services/memory/README.md:24`) |
| Read lens `ContextLens { tenant_id, user_id, … }` | `services/gateway/src/services/memory-broker.ts:81-83` | VI | **Canonical memory read** |
| Memory routes behind `requireAuthWithTenant` | `services/gateway/src/routes/memory-garden.ts:74` | VI | — |
| Model rule: memory owned by the user, social context per tenant | `docs/MULTI-TENANT-PLAN.md:84` | DN | Design source |
| Orphan cleanup and memory_facts supersede-merge | `docs/multitenancy/MIGRATION-QUEUE.md:39-43`, `docs/multitenancy/MIGRATION-QUEUE.md:55-57` | VI (rows 21-25, 37-39 queued) | Canonical cleanup |
| Dev tenant `…0001` in the memory bridge | `services/gateway/src/services/orb-memory-bridge.ts:69` | II | No (to be removed by `tenant-db-and-slug-cleanup`, `.kiro/specs/mt-identity-r2/tasks.md:190`) |
| KB overlay `knowledge_docs.tenant_id` | `supabase/migrations/20261102080000_mt_packs_knowledge_docs_tenant_id.sql:38` | VI (row 40 queued, `docs/multitenancy/MIGRATION-QUEUE.md:58`) | Canonical KB overlay column |
| Health home tenant `app_users.health_home_tenant_id` + `health_home_tenant_id(uuid)` | `supabase/migrations/20261102130000_vtid_05595_health_home_tenant_column.sql:45`, `supabase/migrations/20261102130100_vtid_05595_health_home_tenant_resolver_backfill.sql:67` | VI (rows 43-44 queued) | **Canonical health tenant** |

### 1.8 Jobs, events and registries: tenant keys

| Contract | Where | Class | Canonical? |
|---|---|---|---|
| Job tenant loop (see 1.2) | `services/gateway/src/services/jobs/job-tenant-loop.ts:152` | VI (dark) | Canonical |
| `DEFAULT_TENANT_ID` dispatch still read by 16 gateway source files (index.ts, community.ts, matchmaking.ts, scheduled-notifications.ts, social-connect.ts, …) | `services/gateway/src/routes/community.ts:99` | II (MT WS6 removes it, `docs/MULTI-TENANT-PLAN.md:113`) | No |
| OASIS events carry no tenant column; tenant-admin access to them is platform-scope only | `services/gateway/src/middleware/require-tenant-admin.ts:165-166`, emitter `services/gateway/src/services/oasis-event-service.ts:59` | II | OASIS stays platform-scoped; no workstream adds an ad-hoc tenant key |
| Server tenant metadata cache (`tenants.slug`, `is_default`, `is_platform`) | `services/gateway/src/services/tenancy/tenant-context-repository.ts:30` | VI | Canonical server registry |
| Public tenant registry (see 1.1) | `supabase/migrations/20261014000600_vtid_05151_public_tenant_registry.sql:111` | VO (row 7) | Canonical client registry |
| Platform tenant `tenants.is_platform` (never resolved from host/slug) | `supabase/migrations/20261014000100_vtid_05149_tenants_default_platform_flags.sql:44`, rule `docs/MULTI-TENANT-PLAN.md:62` | VO (row 2) | Canonical |

### 1.9 Branding and destination identity

| Contract | Where | Class | Canonical? |
|---|---|---|---|
| Brand pack on `tenants`: display_name, brand, legal_entity_line, support/sender, locales, timezone, currency, landing, persona_facts | `supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql:36-49` | VO (row 5, RUN-MIGRATION 38451964236, `docs/multitenancy/MIGRATION-QUEUE.md:22`) | **Canonical brand pack** |
| Older `tenant_settings.branding` / `profile` / `domains` JSONB | `supabase/migrations/20260412300000_tenant_settings.sql:8-14` | II | No for new brand data (brand pack wins) |
| Persona layering `getEffectiveConfig(surface, tenantId)` over `tenant_assistant_config` | `services/gateway/src/services/ai-personality-service.ts:658`, `supabase/migrations/20260412200000_tenant_assistant_config.sql:9` | VI | **Canonical persona config** |
| Content overrides `tenant_content_overrides` | `supabase/migrations/20261101100000_mt_packs_tenant_content_overrides.sql:32` | VI (row 8a pending, `docs/multitenancy/MIGRATION-QUEUE.md:26`) | Canonical content pack |
| Email branding `tenant_email_branding` + `fn_tenant_email_branding` (vitana-v1) | `vitana-v1/supabase/migrations/20261101090000_vtid_05245_tenant_email_branding.sql:68`, `vitana-v1/supabase/migrations/20261101090000_vtid_05245_tenant_email_branding.sql:104` | VI (row 11 queued, `docs/multitenancy/MIGRATION-QUEUE.md:29`) | Canonical email brand |
| v1 theme variables from the registry entry | `vitana-v1/src/hooks/useTenant.tsx:128-130`, type `vitana-v1/src/lib/tenant-registry.ts:25` | II (theme-tokens-r3 VTID-05484 is DN) | Canonical client brand source = registry |
| Destination identity rules and follow-ups D1-D6 (ecosystem landing, neutral sign-in, anonymous Vitana, native fallback) | `draft-05689/docs/programs/strategy-execution/destination-identity-strategy.md:224` (draft, not merged) | DN | Not a contract yet; it proposes changes inside the owning MT specs |
| `mt-frontend-brand-r3` does not cover the host map, `/auth` or guest fallback | `draft-05689/docs/programs/strategy-execution/destination-identity-strategy.md:130-133` (draft, not merged) | DN | — |

### 1.10 Rollout flags

| Flag | Where | Class | Canonical? |
|---|---|---|---|
| Env master `MT_RESOLUTION_V2=true` | `services/gateway/src/services/mt-flags.ts:23` | UK (deployed value not read) | **The one env master**; every MT code change is dark behind it (`docs/MULTI-TENANT-PLAN.md:132`) |
| Per-tenant `tenant_settings.feature_flags.mt.*` (`jobs_tenant_loop` today) | `services/gateway/src/services/mt-flags.ts:30-41`, column `supabase/migrations/20260412300000_tenant_settings.sql:11` | VI | **Canonical per-tenant flag store** |
| Governed merge of feature flags `tenant_settings_merge_feature_flags` | `supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql:176` | VO (row 5) | Canonical writer |
| v1 reader `useTenantFeatureFlag(key)` | `vitana-v1/src/hooks/useTenantFeatureFlag.ts:20` | VI | Canonical client reader |
| Planned keys: `mt.packs`, `mt.network_enabled`, `mt.network_groups`, `mt.discover_tenant_gate`, `mt.moderator_tenant_scope`, `mt.launch_pipeline`, `mt.launch_analytics`, `mt.launch_support` | `.kiro/specs/mt-packs-r2/plan.md:126`, `.kiro/specs/mt-network-r2/plan.md:147`, `.kiro/specs/mt-discover-r2/plan.md:193`, `.kiro/specs/mt-launch/plan.md:40` | DN (values) | Keys belong to their spec; no workstream invents an `mt.*` key |

## 2. Open MT specs and lanes

Counts at the pin. The programme lists 16 specs (`docs/programs/multi-tenant/program.md:7-23`); 18 spec folders exist
(`multi-tenant`, 15 `mt-*-r2`/`mt-*` specs, plus done `mt-local-stack-replay-skips-r1` and `mt-schema-queue-followup-r2`).
They hold 90 lane files: 34 `done`, 48 `ready`, 2 `executing`, 2 `in-review`, 4 `parked`, so **56 lane files are not done**.
Of these, 5 are recorded as superseded and 2 parked lanes were replaced by a done lane, leaving **49 open lanes**; 3 of
those carry a stale state because their PR is already merged. The strategy's list of open MT lanes (VTID-05221,
VTID-05267..05270, VTID-05323..05327, `vitanaland-strategy/19-EXECUTION-PROGRAMME/SESSION-HANDOVER.md:181-182`) is a
subset of this.

Hot files that every lane must sequence: migrations in timestamp order, `DATABASE_SCHEMA.md`, `src/App.tsx`,
`screens.json`/`exclusions.json`, the parity ledger, same-namespace i18n shards, `CLAUDE.md`
(`.claude/rules/collaboration.md:358-360`), plus `docs/multitenancy/MIGRATION-QUEUE.md` (`.kiro/specs/mt-data-cleanup-r2/plan.md:64`),
`services/gateway/src/routes/orb-live.ts` (`.kiro/specs/mt-packs-r2/plan.md:327`) and Command Hub `app.js` / `cors.ts`
(`.kiro/specs/mt-frontend-brand/plan.md:181`).

### 2.1 Lanes not done (state line, VTID, PR, protected paths)

"Paths" are the lane's `paths:` (its protected paths; only the first three shown, count first). "Shared" names another
open lane that lists the same file.

| Spec | Lane | State | VTID | PR | Paths (count: first three) | Shared / hot |
|---|---|---|---|---|---|---|
| multi-tenant | provisioning-ui | in-review `.kiro/specs/multi-tenant/lanes/provisioning-ui.md:3` | VTID-05221 | vitana-v1 #1438 open | no `paths:` in front matter | — |
| mt-data-cleanup-r2 | engine-tenant-fallbacks | ready `.kiro/specs/mt-data-cleanup-r2/lanes/engine-tenant-fallbacks.md:3` | VTID-05568 | — | 5: d46/d48/d49 engines, `opportunity-surfacing.ts` | — |
| mt-discover-r2 | discover-mode-ui | ready `.kiro/specs/mt-discover-r2/lanes/discover-mode-ui.md:3` | VTID-05485 | — | 12: `src/pages/Discover.tsx`, `src/components/discover/**`, `src/components/commerce/**` | `docs/SCREEN_INVENTORY.md` (7 lanes) |
| mt-discover-r2 | discover-shared-predicate | ready `.kiro/specs/mt-discover-r2/lanes/discover-shared-predicate.md:3` | VTID-05486 | — | 35: `services/discover/**`, discover feed/search/recommendation repositories | health-wellness / health-action-initiative repositories with health-tenant-accessor (`.kiro/specs/mt-discover-r2/lanes/discover-shared-predicate.md:26`); partner-onboarding files with supplier-onboarding-communities (`.kiro/specs/mt-discover-r2/lanes/discover-shared-predicate.md:31`) |
| mt-discover-r2 | supplier-onboarding-communities | ready `.kiro/specs/mt-discover-r2/lanes/supplier-onboarding-communities.md:3` | VTID-05487 | — | 8: `partner-onboarding-service.ts`, `partner-onboarding.ts`, `partner-onboarding-catalogue.ts` | same spec, above |
| mt-frontend-brand | adminfetch-header | ready `.kiro/specs/mt-frontend-brand/lanes/adminfetch-header.md:3` | VTID-05241 | — | 2: `src/lib/admin-api.ts` (v1) | — |
| mt-frontend-brand | brand-surface | parked `.kiro/specs/mt-frontend-brand/lanes/brand-surface.md:3` | VTID-05242 | vitana-v1 #1485 closed, not merged | 12 | DS: superseded by brand-surface-r3 (`.kiro/specs/mt-frontend-brand-r3/plan.md:46`) |
| mt-frontend-brand | cors-config | ready `.kiro/specs/mt-frontend-brand/lanes/cors-config.md:3` | VTID-05243 | — | 2: `services/gateway/src/middleware/cors.ts` | hot (`cors.ts`) |
| mt-frontend-brand | email-brand-code | ready `.kiro/specs/mt-frontend-brand/lanes/email-brand-code.md:3` | VTID-05244 | — | 10: v1 edge functions incl. `send-welcome-discount` (`.kiro/specs/mt-frontend-brand/lanes/email-brand-code.md:13`) | Track S S-H subject |
| mt-frontend-brand | email-brand-db | in-review `.kiro/specs/mt-frontend-brand/lanes/email-brand-db.md:3` | VTID-05245 | vitana-v1 #1464 **merged** | 3: v1 migration, queue file | stale state; queue row 11 |
| mt-frontend-brand | theme-tokens | ready `.kiro/specs/mt-frontend-brand/lanes/theme-tokens.md:3` | VTID-05246 | — | 8 | DS: superseded by theme-tokens-r3 (`.kiro/specs/mt-frontend-brand-r3/plan.md:46`) |
| mt-frontend-brand-r3 | brand-surface-r3 | ready `.kiro/specs/mt-frontend-brand-r3/lanes/brand-surface-r3.md:3` | VTID-05483 | — | 24: `CommerceJoin.tsx`, `AuthGuard.tsx` (`.kiro/specs/mt-frontend-brand-r3/lanes/brand-surface-r3.md:15`), `src/App.tsx` (`.kiro/specs/mt-frontend-brand-r3/lanes/brand-surface-r3.md:22`) | `src/App.tsx` hot, shared with tenant-admin-pages |
| mt-frontend-brand-r3 | theme-tokens-r3 | ready `.kiro/specs/mt-frontend-brand-r3/lanes/theme-tokens-r3.md:3` | VTID-05484 | — | 5: `src/lib/tenant-theme.ts`, `src/hooks/useTenant.tsx` (`.kiro/specs/mt-frontend-brand-r3/lanes/theme-tokens-r3.md:14`) | — |
| mt-guardrails-r2 | ci-wiring | ready `.kiro/specs/mt-guardrails-r2/lanes/ci-wiring.md:3` | VTID-05443 | — | 4: `MT-GUARDRAILS.yml`, `SQL-MT-ISOLATION.yml`, `MORNING-SYSTEM-HEALTH-CHECK.yml` (`.kiro/specs/mt-guardrails-r2/lanes/ci-wiring.md:13`) | — |
| mt-guardrails-r2 | gateway-scope-lint-contract | ready `.kiro/specs/mt-guardrails-r2/lanes/gateway-scope-lint-contract.md:3` | VTID-05444 | — | 5: `scripts/mt/gateway-scope-lint.mjs`, route inventory and canary tests | — |
| mt-guardrails-r2 | local-test-stack | parked `.kiro/specs/mt-guardrails-r2/lanes/local-test-stack.md:3` | VTID-05447 | — | 4 | DS in practice: PGlite lane done (`.kiro/specs/mt-guardrails-r2/lanes/local-test-stack-pglite.md:24`) |
| mt-guardrails-r2 | local-test-stack-v2 | parked `.kiro/specs/mt-guardrails-r2/lanes/local-test-stack-v2.md:3` | VTID-05469 | — | 5 | as above |
| mt-guardrails-r2 | maxina-golden-suite | ready `.kiro/specs/mt-guardrails-r2/lanes/maxina-golden-suite.md:3` | VTID-05448 | — | 3: `services/gateway/test/mt-maxina-golden.test.ts`, `test/golden/**` | — |
| mt-identity-r2 | tenant-db-and-slug-cleanup | ready `.kiro/specs/mt-identity-r2/lanes/tenant-db-and-slug-cleanup.md:3` | VTID-05468 | — | 20: `tenancy/tenant-db.ts`, `tenancy/tenant-tables.ts`, `tenancy/health-db.ts` | `tenant-context.ts` with host-resolution-gw (`.kiro/specs/mt-identity-r2/lanes/tenant-db-and-slug-cleanup.md:18`) |
| mt-jobs | jobs-automation-actor-tenant | ready `.kiro/specs/mt-jobs/lanes/jobs-automation-actor-tenant.md:3` | VTID-05267 | — | 7: `community.ts`, `match-feedback.ts`, `matchmaking.ts` | — |
| mt-jobs | jobs-community-scan-tenant | executing `.kiro/specs/mt-jobs/lanes/jobs-community-scan-tenant.md:3` | VTID-05268 | vitana-platform #4319 **merged** | 5: `scan-runner.ts` (`.kiro/specs/mt-jobs/lanes/jobs-community-scan-tenant.md:13`) | stale state |
| mt-jobs | jobs-env-prepare | ready `.kiro/specs/mt-jobs/lanes/jobs-env-prepare.md:3` | VTID-05269 | — | 5: `scripts/aws/setup-eventbridge-*.sh` | — |
| mt-jobs | jobs-tenant-loop | ready `.kiro/specs/mt-jobs/lanes/jobs-tenant-loop.md:3` | VTID-05270 | — | 9: `mt-flags.ts`, `job-tenant-loop.ts`, `services/gateway/src/index.ts` (`.kiro/specs/mt-jobs/lanes/jobs-tenant-loop.md:12`) | `index.ts` with two mt-launch lanes |
| mt-launch | pack-intake-admin | ready `.kiro/specs/mt-launch/lanes/pack-intake-admin.md:3` | VTID-05323 | — | 14: `tenant-admin/pack-intake.ts`, its repository, `index.ts` (`.kiro/specs/mt-launch/lanes/pack-intake-admin.md:19`) | `index.ts` |
| mt-launch | pack-intake-db | executing `.kiro/specs/mt-launch/lanes/pack-intake-db.md:3` | VTID-05324 | vitana-platform #4265 **merged** | 5: two migrations, queue file | stale state; queue rows 9-10 |
| mt-launch | support-landing | ready `.kiro/specs/mt-launch/lanes/support-landing.md:3` | VTID-05325 | — | 7: `tenant-launch/support-routing.ts`, `feedback-admin.ts`, `feedback-intake.ts` | — |
| mt-launch | tenant-owner-analytics | ready `.kiro/specs/mt-launch/lanes/tenant-owner-analytics.md:3` | VTID-05326 | — | 6: `tenant-admin/owner-analytics.ts`, `index.ts` (`.kiro/specs/mt-launch/lanes/tenant-owner-analytics.md:12`) | `index.ts` |
| mt-launch | worker-test-gate | ready `.kiro/specs/mt-launch/lanes/worker-test-gate.md:3` | VTID-05327 | — | 2: `PR-GATE.yml` (`.kiro/specs/mt-launch/lanes/worker-test-gate.md:9`) | — |
| mt-m3-r2 | host-resolution-gw | ready `.kiro/specs/mt-m3-r2/lanes/host-resolution-gw.md:3` | VTID-05502 | — | 3: `tenant-context.ts`, `auth-supabase-jwt.ts` (`.kiro/specs/mt-m3-r2/lanes/host-resolution-gw.md:11-12`) | `tenant-context.ts` with tenant-db-and-slug-cleanup |
| mt-m3-r2 | monitoring-erp-gw | ready `.kiro/specs/mt-m3-r2/lanes/monitoring-erp-gw.md:3` | VTID-05503 | — | 2: `routes/admin-health.ts` | — |
| mt-m3-r2 | native-domains-aasa | ready `.kiro/specs/mt-m3-r2/lanes/native-domains-aasa.md:3` | VTID-05505 | — | 6: AASA, assetlinks, `apps/mobile/parity/**` (`.kiro/specs/mt-m3-r2/lanes/native-domains-aasa.md:13`) | parity ledger hot |
| mt-m3-r2 | tenant-switcher-ui | ready `.kiro/specs/mt-m3-r2/lanes/tenant-switcher-ui.md:3` | VTID-05508 | — | 8: `src/components/tenant-switcher/**` | `SCREEN_INVENTORY.md` |
| mt-m3-r2 | wizard-price-polish | ready `.kiro/specs/mt-m3-r2/lanes/wizard-price-polish.md:3` | VTID-05509 | — | 10: `src/components/admin/tenant-provisioning/**` (`.kiro/specs/mt-m3-r2/lanes/wizard-price-polish.md:12`) | `SCREEN_INVENTORY.md` |
| mt-native-health-r2 | health-analytics-lineage-guard | ready `.kiro/specs/mt-native-health-r2/lanes/health-analytics-lineage-guard.md:3` | VTID-05594 | — | 5: lineage inventory generator and guard tests | — |
| mt-native-health-r2 | health-tenant-accessor | ready `.kiro/specs/mt-native-health-r2/lanes/health-tenant-accessor.md:3` | VTID-05596 | — | 10: `services/gateway/src/data/health-db.ts` (`.kiro/specs/mt-native-health-r2/lanes/health-tenant-accessor.md:11`), `routes/health.ts` (`.kiro/specs/mt-native-health-r2/lanes/health-tenant-accessor.md:15`) | health repositories with discover-shared-predicate (`.kiro/specs/mt-native-health-r2/lanes/health-tenant-accessor.md:16`) |
| mt-native-health-r2 | health-writers-voice-orb | ready `.kiro/specs/mt-native-health-r2/lanes/health-writers-voice-orb.md:3` | VTID-05597 | — | 8: `voice-tools/health-log*.ts`, `orb-tools/health-depth-tools*.ts` | — |
| mt-native-health-r2 | native-push-tenant | ready `.kiro/specs/mt-native-health-r2/lanes/native-push-tenant.md:3` | VTID-05598 | — | 4: `notification-service.ts` (`.kiro/specs/mt-native-health-r2/lanes/native-push-tenant.md:12`), `push-routing.ts` | — |
| mt-native-health-r2 | native-tenant-isolation-tests | ready `.kiro/specs/mt-native-health-r2/lanes/native-tenant-isolation-tests.md:3` | VTID-05599 | — | 3: `apps/mobile/tests/mt-native-health/**` | — |
| mt-network-r2 | matching-discover-scope-v1 | ready `.kiro/specs/mt-network-r2/lanes/matching-discover-scope-v1.md:3` | VTID-05574 | — | 7: `generate-daily-matches`, `useRealMatches.ts`, i18n `screens.json` (`.kiro/specs/mt-network-r2/lanes/matching-discover-scope-v1.md:16-17`) | i18n shards hot |
| mt-network-r2 | messaging-send-gateway | ready `.kiro/specs/mt-network-r2/lanes/messaging-send-gateway.md:3` | VTID-05577 | — | 12: `chat.ts`, `chat-repository.ts`, `orb-tools-shared.ts` (`.kiro/specs/mt-network-r2/lanes/messaging-send-gateway.md:13`) | `orb-tools-shared.ts` (3 lanes); `chat-groups-repository.ts` with network-groups-gateway |
| mt-network-r2 | messenger-wiring | ready `.kiro/specs/mt-network-r2/lanes/messenger-wiring.md:3` | VTID-05578 | — | 11: `src/pages/Messages.tsx` (`.kiro/specs/mt-network-r2/lanes/messenger-wiring.md:12`), `useGlobalMessages.ts`, `useHybridMessages.ts` | `Messages.tsx` with network-groups-v1 |
| mt-network-r2 | network-groups-gateway | ready `.kiro/specs/mt-network-r2/lanes/network-groups-gateway.md:3` | VTID-05580 | — | 3: `chat-groups-repository.ts`, `chat-groups.ts` | same spec |
| mt-network-r2 | network-groups-v1 | ready `.kiro/specs/mt-network-r2/lanes/network-groups-v1.md:3` | VTID-05581 | — | 5: `src/components/messages/**`, `Messages.tsx` | same spec |
| mt-network-r2 | orb-recipient-scope-gateway | ready `.kiro/specs/mt-network-r2/lanes/orb-recipient-scope-gateway.md:3` | VTID-05583 | — | 2: `orb-tools-shared.ts` (`.kiro/specs/mt-network-r2/lanes/orb-recipient-scope-gateway.md:11`) | `orb-tools-shared.ts` |
| mt-packs-r2 | brand-content-templating | ready `.kiro/specs/mt-packs-r2/lanes/brand-content-templating.md:3` | VTID-05494 | — | 4: `data/feature-tips.ts`, `notification-controls/**`, gateway i18n | — |
| mt-packs-r2 | frontend-brand-neutralise | ready `.kiro/specs/mt-packs-r2/lanes/frontend-brand-neutralise.md:3` | VTID-05496 | — | 7: `src/i18n/**`, `useOrbFrontDoor.ts`, `useOrbVoiceWidget.ts` | i18n shards hot |
| mt-packs-r2 | kb-overlay-code | ready `.kiro/specs/mt-packs-r2/lanes/kb-overlay-code.md:3` | VTID-05497 | — | 5: `retrieval-router.ts` (`.kiro/specs/mt-packs-r2/lanes/kb-overlay-code.md:11`), `orb-tools-shared.ts` (`.kiro/specs/mt-packs-r2/lanes/kb-overlay-code.md:12`) | `orb-tools-shared.ts` |
| mt-packs-r2 | persona-pack | ready `.kiro/specs/mt-packs-r2/lanes/persona-pack.md:3` | VTID-05499 | — | 11: `ai-personality-service.ts` (`.kiro/specs/mt-packs-r2/lanes/persona-pack.md:11`), `orb/profile/**`, `routes/orb-live.ts` (`.kiro/specs/mt-packs-r2/lanes/persona-pack.md:15`) | `orb-live.ts` hot |
| mt-packs-r2 | whats-new-drafter-prompt | ready `.kiro/specs/mt-packs-r2/lanes/whats-new-drafter-prompt.md:3` | VTID-05500 | — | 1: `WHATS-NEW-DRAFT.yml` (v1) | — |
| mt-packs-r2 | whats-new-golden-regen | ready `.kiro/specs/mt-packs-r2/lanes/whats-new-golden-regen.md:3` | VTID-05501 | — | 1: `test/golden/v1-golden-edge.*` | — |
| mt-tenant-admin-r2 | command-hub-tenant-module | ready `.kiro/specs/mt-tenant-admin-r2/lanes/command-hub-tenant-module.md:3` | VTID-05489 | — | 7: `command-hub/tenant-admin.js`, `modules.json`, `app.js` (`.kiro/specs/mt-tenant-admin-r2/lanes/command-hub-tenant-module.md:15`) | `app.js` hot |
| mt-tenant-admin-r2 | tenant-admin-api | ready `.kiro/specs/mt-tenant-admin-r2/lanes/tenant-admin-api.md:3` | VTID-05490 | — | 12: `admin-tenants.ts` (`.kiro/specs/mt-tenant-admin-r2/lanes/tenant-admin-api.md:11`), its repository, `admin-signups.ts` | — |
| mt-tenant-admin-r2 | tenant-admin-pages | ready `.kiro/specs/mt-tenant-admin-r2/lanes/tenant-admin-pages.md:3` | VTID-05492 | — | 14: `InvitationAccept.tsx`, `src/App.tsx` (`.kiro/specs/mt-tenant-admin-r2/lanes/tenant-admin-pages.md:17`), `screens.json` (`.kiro/specs/mt-tenant-admin-r2/lanes/tenant-admin-pages.md:20`), parity ledger (`.kiro/specs/mt-tenant-admin-r2/lanes/tenant-admin-pages.md:22`) | `App.tsx`, `screens.json`, ledger hot |
| mt-track-s-authz | approvals-auth | ready `.kiro/specs/mt-track-s-authz/lanes/approvals-auth.md:3` | VTID-05452 | — | 6: `approvals.ts`, `developer-tools.ts`, `orb-live.ts` | DS: superseded by v2 (`.kiro/specs/mt-track-s-authz/handoff.md:52`) |
| mt-track-s-authz | work-surface-permission | ready `.kiro/specs/mt-track-s-authz/lanes/work-surface-permission.md:3` | VTID-05453 | — | 6 | DS: superseded by v2 (`.kiro/specs/mt-track-s-authz/lanes/work-surface-permission-v2.md:26`) |
| mt-track-s-r2 | s-j-retire-allowlist | parked `.kiro/specs/mt-track-s-r2/lanes/s-j-retire-allowlist.md:3` | VTID-05441 | — | 2 | DS: superseded by v2 (`.kiro/specs/mt-track-s-r2/lanes/s-j-retire-allowlist-v2.md:22`) |

Not on `main` (plan PRs only, no lanes at the pin): `mt-community-isolation-r2` (PR #4582; WS3 Community part; its C3
version `20261102070160` is reserved in the queue, `docs/multitenancy/MIGRATION-QUEUE.md:53`), `mt-network` (PR #4171,
older WS3 plan), `ia-architecture-map-r2` (PR #4601, joins the Integrated Architecture map to the MT programme as WS-IA).

### 2.2 Open pull requests (GitHub, read 2026-11-11)

vitana-platform has 156 open PRs; 26 belong to the MT programme by branch (`mt-*`, `multi-tenant`) or title: #4935
(mt-guardrails-r2 plan-2 seat move), #4932 VTID-05493, #4931 VTID-05491, #4930 VTID-05504, #4929 VTID-05506, #4928
VTID-05569, #4927 VTID-05573, #4926 VTID-05579, #4925 VTID-05575, #4924 VTID-05576 (M0 audit notes of done lanes), #4923
VTID-05569, #4922 VTID-05464, #4921 VTID-05465 (owner packets for queue rows 57-58, 17-18, 12-13), #4920
(mt-queue-superseded-close plan), #4919 and #4755 (programme directive and handover docs), #4602, #4588, #4586, #4526,
#4525, #4524, #4481 (pm-agent bookkeeping), #4601, #4582, #4171 (plan PRs above). vitana-v1 has 52 open PRs; one is MT:
#1438 (VTID-05221 provisioning-ui). Wave-1 PR #4948 (VTID-05693, tenant security evidence) is related but not an MT spec.
Command and output: `docs/validation/VTID-05717/commands.log`.

### 2.3 Migration queue rows not applied

64 rows; 8 applied (rows 1-8, `docs/multitenancy/MIGRATION-QUEUE.md:18-25`); 3 `pending` and 53 `queued (pending owner
approval)`. Rows 59-60 are reserved. Every row needs owner approval of the file and target database (collaboration §7d).

| Rows | Lane / VTID | Queue lines | Order constraint |
|---|---|---|---|
| 8a | mt-packs-r2 content-overrides-db VTID-05495 | `docs/multitenancy/MIGRATION-QUEUE.md:26` | before rows 9-10 |
| 9-10 | mt-launch pack-intake-db VTID-05324 | `docs/multitenancy/MIGRATION-QUEUE.md:27-28` | after 8a |
| 11 | mt-frontend-brand email-brand-db VTID-05245 (vitana-v1) | `docs/multitenancy/MIGRATION-QUEUE.md:29` | before email-brand-code deploys |
| 12-13 | mt-identity-r2 VTID-05465 helpers + bare-policy rewrite | `docs/multitenancy/MIGRATION-QUEUE.md:30-31` | 13 after 12 |
| 14-16 | mt-identity-r2 VTID-05466 membership unification | `docs/multitenancy/MIGRATION-QUEUE.md:32-34` | after 13 |
| 17-18 | mt-identity-r2 VTID-05464 access-token hook shadow | `docs/multitenancy/MIGRATION-QUEUE.md:35-36` | plus auth-config step (D14) |
| 19-20 | mt-identity-r2 VTID-05467 role source, bootstrap_admin fix | `docs/multitenancy/MIGRATION-QUEUE.md:37-38` | after 14, 16 |
| 21-25 | mt-data-cleanup-r2 VTID-05571 orphans | `docs/multitenancy/MIGRATION-QUEUE.md:39-43` | after 14, 16 |
| 26-29 | mt-discover-r2 VTID-05488 supplier relationships, distribution, RLS | `docs/multitenancy/MIGRATION-QUEUE.md:44-47` | 29 after 26-27 |
| 30-31 | mt-m3-r2 VTID-05507 tenant_domains, host resolver | `docs/multitenancy/MIGRATION-QUEUE.md:48-49` | 31 after 30 |
| 32-33 | mt-tenant-admin-r2 VTID-05493 lifecycle | `docs/multitenancy/MIGRATION-QUEUE.md:50-51` | after C3 `070160` |
| 34-36 | mt-tenant-admin-r2 VTID-05491 moderation | `docs/multitenancy/MIGRATION-QUEUE.md:52-54` | 36 after C3 |
| 37-39 | mt-data-cleanup-r2 VTID-05570 memory_facts merge | `docs/multitenancy/MIGRATION-QUEUE.md:55-57` | after 21-25 |
| 40 | mt-packs-r2 VTID-05498 knowledge_docs.tenant_id | `docs/multitenancy/MIGRATION-QUEUE.md:58` | free |
| 41-42 | mt-data-cleanup-r2 VTID-05572 profiles backfill | `docs/multitenancy/MIGRATION-QUEUE.md:59-60` | after 14, 16, 21-24 |
| 43-44 | mt-native-health-r2 VTID-05595 health home tenant | `docs/multitenancy/MIGRATION-QUEUE.md:61-62` | 44 after 14-16 |
| 45-47 | mt-network-r2 VTID-05576 messaging send | `docs/multitenancy/MIGRATION-QUEUE.md:63-65` | 47 after messaging-send-gateway deploys |
| 48-49 | mt-network-r2 VTID-05582 network visibility | `docs/multitenancy/MIGRATION-QUEUE.md:66-67` | before any network send |
| 50-53 | mt-network-r2 VTID-05573 legacy messages | `docs/multitenancy/MIGRATION-QUEUE.md:68-71` | 50 after legacy readers retire |
| 54-56 | mt-network-r2 VTID-05575 matching scope | `docs/multitenancy/MIGRATION-QUEUE.md:72-74` | after 48 |
| 57-58 | mt-data-cleanup-r2 VTID-05569 hot-table NOT NULL assert | `docs/multitenancy/MIGRATION-QUEUE.md:75-76` | last of data cleanup |
| 61-62 | mt-m3-r2 VTID-05506 ERP request, per-tenant isolation health | `docs/multitenancy/MIGRATION-QUEUE.md:77-78` | 61 re-creates `provision_tenant()` |
| 63-65 | mt-network-r2 VTID-05579 network groups | `docs/multitenancy/MIGRATION-QUEUE.md:79-81` | after 52 |

The queue is enforced by review only until the WS0 lint (`docs/multitenancy/MIGRATION-QUEUE.md:8-9`). Any workstream
migration that touches a table named above sorts after that table's rows and adds its own row in the same PR
(`docs/multitenancy/MIGRATION-QUEUE.md:3-6`).

## 3. The 18 workstreams

Workstreams and names are the strategy registry's (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:11`);
the registry is a planning index, not a task system (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:10`).
Module ids are from `vitanaland-strategy/02-PLATFORM/module-ownership.json`. "Must consume" points at §1 rows; "must
not duplicate" names the existing contract a workstream may not rebuild. Every conflict names the MT spec and file.
The last column maps the MT plan's own work streams (WS-S, WS0-WS11, `docs/MULTI-TENANT-PLAN.md:106-118`) that act on
this workstream; all of them are owned by WS03.

| WS | Name (registry) | Modules | Must consume | Must not duplicate | Conflicts with open MT lanes | MT plan work streams (owned by WS03) |
|---|---|---|---|---|---|---|
| WS01 | Strategy Repository and Governance (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:13`) | MOD-GOVERNANCE (`vitanaland-strategy/02-PLATFORM/module-ownership.json:1125`) | MT plan §8 delivery model, dark by default (`docs/MULTI-TENANT-PLAN.md:132`); the queue as the one ordered list (`docs/multitenancy/MIGRATION-QUEUE.md:3`); hot-file rule (`.claude/rules/collaboration.md:358`) | A second MT tracker or lane ledger; lane state lives in the spec files (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:10`) | Stale lane states (`.kiro/specs/mt-jobs/lanes/jobs-community-scan-tenant.md:3`, `.kiro/specs/mt-launch/lanes/pack-intake-db.md:3`, `.kiro/specs/mt-frontend-brand/lanes/email-brand-db.md:3`) and the stale "nothing built yet" line (`docs/MULTI-TENANT-PLAN.md:3`) that SB-MT-04 asks to record (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:1456`); open plan PR #4920 handles superseded-lane closure | §8 delivery model (all) |
| WS02 | Integrated Architecture and Modularisation (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:26`) | MOD-CORE (`vitanaland-strategy/02-PLATFORM/module-ownership.json:20`), MOD-DATA (`vitanaland-strategy/02-PLATFORM/module-ownership.json:53`), MOD-NOTIFICATIONS (`vitanaland-strategy/02-PLATFORM/module-ownership.json:432`) | §1.2 TenantContext; §2.3 queue for every DB change; MT generated inventories (mt-guardrails-r2 `generated-inventories` VTID-05445, done) | A module-level tenant model; `tenant_awareness` values must point at MOD-TENANT contracts, not define new ones | `services/gateway/src/index.ts` (MOD-CORE path) is in three MT lanes: mt-jobs `.kiro/specs/mt-jobs/lanes/jobs-tenant-loop.md:12`, mt-launch `.kiro/specs/mt-launch/lanes/pack-intake-admin.md:19` and `.kiro/specs/mt-launch/lanes/tenant-owner-analytics.md:12`; notifications: mt-native-health-r2 `native-push-tenant` (`.kiro/specs/mt-native-health-r2/lanes/native-push-tenant.md:12`); MOD-DATA owns migrations, so timestamp order applies; plan PR #4601 (WS-IA) | WS0, WS6 |
| WS03 | Multi-Tenant (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:39`) | MOD-TENANT (`vitanaland-strategy/02-PLATFORM/module-ownership.json:114`), MOD-IDENTITY (`vitanaland-strategy/02-PLATFORM/module-ownership.json:82`), MOD-COMMUNITY (`vitanaland-strategy/02-PLATFORM/module-ownership.json:402`) | Owner of every §1 contract; tasks SB-MT-01..04 (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:1218`, `vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:1313`, `vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:1379`, `vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:1456`) | Restarting MT or a parallel MT plan (`plan-mt-align/.kiro/specs/architecture-mt-alignment/plan.md:17`) | Inside MT: `orb-tools-shared.ts` in mt-network-r2 (`.kiro/specs/mt-network-r2/lanes/messaging-send-gateway.md:13`, `.kiro/specs/mt-network-r2/lanes/orb-recipient-scope-gateway.md:11`) and mt-packs-r2 (`.kiro/specs/mt-packs-r2/lanes/kb-overlay-code.md:12`); `tenant-context.ts` in mt-identity-r2 (`.kiro/specs/mt-identity-r2/lanes/tenant-db-and-slug-cleanup.md:18`) and mt-m3-r2 (`.kiro/specs/mt-m3-r2/lanes/host-resolution-gw.md:11`); two planned `healthDb` files, mt-identity-r2 (`.kiro/specs/mt-identity-r2/lanes/tenant-db-and-slug-cleanup.md:17`) vs mt-native-health-r2 (`.kiro/specs/mt-native-health-r2/lanes/health-tenant-accessor.md:11`); health repositories in mt-discover-r2 (`.kiro/specs/mt-discover-r2/lanes/discover-shared-predicate.md:26`) and mt-native-health-r2 (`.kiro/specs/mt-native-health-r2/lanes/health-tenant-accessor.md:16`) | WS-S, WS0-WS11, M3 (see §3.1) |
| WS04 | Vitana AI and Conversation Intelligence (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:50`) | MOD-AI-ROUTING (`vitanaland-strategy/02-PLATFORM/module-ownership.json:184`), MOD-VITANA-INTEL (`vitanaland-strategy/02-PLATFORM/module-ownership.json:207`), MOD-CHANNELS (`vitanaland-strategy/02-PLATFORM/module-ownership.json:241`), MOD-CONTEXT-JOURNEY (`vitanaland-strategy/02-PLATFORM/module-ownership.json:338`) | `requireAuthWithTenant` / `getTenantContext` for routes; `getEffectiveConfig(surface, tenantId)` (`services/gateway/src/services/ai-personality-service.ts:658`); persona pack facts, never templated speech (`docs/MULTI-TENANT-PLAN.md:56`); `resolvePrimaryTenant()` for ORB tools | A persona/brand store or tenant prompt copies; ORB-local tenant lookups such as `services/gateway/src/services/orb-tools/marketplace-va-shared.ts:46` | `orb-live.ts` hot, in mt-packs-r2 persona-pack (`.kiro/specs/mt-packs-r2/lanes/persona-pack.md:15`); `ai-personality-service.ts` (`.kiro/specs/mt-packs-r2/lanes/persona-pack.md:11`); `orb-tools-shared.ts` (three lanes, WS03 row); flags `MT_RESOLUTION_V2` + `mt.packs` (`.kiro/specs/mt-packs-r2/plan.md:126`); draft D3 anonymous Vitana (`draft-05689/docs/programs/strategy-execution/destination-identity-strategy.md:224`, draft, not merged) | WS5, WS3 (ORB scope), WS-S |
| WS05 | Memory and Personal Context (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:61`) | MOD-MEMORY (`vitanaland-strategy/02-PLATFORM/module-ownership.json:272`), MOD-PRIVACY (`vitanaland-strategy/02-PLATFORM/module-ownership.json:153`) | `rememberFact()` with tenant (`services/gateway/src/services/memory/remember.ts:139`); `ContextLens` (`services/gateway/src/services/memory-broker.ts:81-83`); D8 user-owned memory (`docs/MULTI-TENANT-PLAN.md:84`); cleanup rows 21-25, 37-39 | A memory tenant resolver; the nil-tenant fallback (`services/gateway/src/services/memory/diary.ts:138`) and `services/gateway/src/routes/memory-repository.ts:76` are not to be copied | Migration order: any memory_facts schema change (SB-MEM-02) sorts after mt-data-cleanup-r2 rows 37-39 (`docs/multitenancy/MIGRATION-QUEUE.md:55-57`); `retrieval-router.ts` in mt-packs-r2 kb-overlay-code (`.kiro/specs/mt-packs-r2/lanes/kb-overlay-code.md:11`) | WS1, WS2 |
| WS06 | Vitanaland Knowledge Graph (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:74`) | MOD-KG (`vitanaland-strategy/02-PLATFORM/module-ownership.json:309`) | `tenant_id_for_policies()` for any graph policy; KB overlay column (`supabase/migrations/20261102080000_mt_packs_knowledge_docs_tenant_id.sql:38`) | A tenant column or policy design for graph tables outside mt-identity-r2; a KB tenant store | mt-identity-r2 rows 12-13 rewrite `relationship_nodes` policies (`supabase/migrations/20261102030100_vtid_05465_bare_policy_rewrite.sql:390-401`), so KG migrations on `relationship_*` sort after row 13; `services/gateway/src/routes/relationships-repository.ts:34` local lookup is in no lane | WS1, WS5, WS3 |
| WS07 | Five Foundational Health Pillars (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:85`) | MOD-HEALTH-PILLARS (`vitanaland-strategy/02-PLATFORM/module-ownership.json:370`) | Health home tenant (`supabase/migrations/20261102130100_vtid_05595_health_home_tenant_resolver_backfill.sql:67`); `isHealthTable()` from mt-identity-r2 only (`.kiro/specs/mt-native-health-r2/plan.md:94`); the lineage guard VTID-05594; tenant admins never see health data (`docs/MULTI-TENANT-PLAN.md:61`) | A health tenant resolver or a local health-table list | `routes/health.ts` in mt-native-health-r2 (`.kiro/specs/mt-native-health-r2/lanes/health-tenant-accessor.md:15`); `services/gateway/src/routes/health-repository.ts:68`; queue rows 43-44 | WS10 |
| WS08 | Native Mobile Applications (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:94`) | MOD-NATIVE (`vitanaland-strategy/02-PLATFORM/module-ownership.json:765`) | Native `TenantProvider` on the DB registry and switch RPC (`vitana-v1/apps/mobile/src/identity/TenantProvider.tsx:116`); per-tenant push via native-push-tenant VTID-05598 | A native tenant registry with its own data | The MT plan describes a Capacitor shell (`docs/MULTI-TENANT-PLAN.md:60`, `docs/MULTI-TENANT-PLAN.md:116`); the app is Expo (`.kiro/specs/mt-native-health-r2/plan.md:301`); parity ledger hot: mt-m3-r2 (`.kiro/specs/mt-m3-r2/lanes/native-domains-aasa.md:13`), mt-tenant-admin-r2 (`.kiro/specs/mt-tenant-admin-r2/lanes/tenant-admin-pages.md:22`); draft D4 and HM F1 (`draft-05690/docs/programs/strategy-execution/healthy-million-readiness.md:441`, draft, not merged) | WS9 |
| WS09 | Website Factory and Skeleton (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:104`) | MOD-SKELETON (`vitanaland-strategy/02-PLATFORM/module-ownership.json:649`), MOD-WEB-FACTORY (`vitanaland-strategy/02-PLATFORM/module-ownership.json:676`) | `resolve_tenant` / `list_public_tenants`; brand pack (`supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql:36-49`); host → tenant only through `tenant_domains` + `resolve_tenant(p_host, p_slug)` | A site or destination registry with its own host map, brand store or slug list | No file overlap (its paths are in the strategy repository); migration order: a site-host table would sort after mt-m3-r2 rows 30-31 (`docs/multitenancy/MIGRATION-QUEUE.md:48-49`); flag `MT_RESOLUTION_V2` for host resolution (`.kiro/specs/mt-m3-r2/plan.md:129`) | WS7, M3 |
| WS10 | Online Presence and Destination Websites (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:114`) | MOD-ONLINE-PRESENCE (`vitanaland-strategy/02-PLATFORM/module-ownership.json:733`) | As WS09; reserved slugs; destination identity drafts D1/D2 | A third host map: `DOMAIN_TENANT_MAP` already duplicates `tenant_domains` (`vitana-v1/src/config/domain-tenant-mapping.ts:5`) | `ShareEntry.tsx` (MOD-ONLINE-PRESENCE path) reads the static map (`vitana-v1/src/pages/ShareEntry.tsx:25`); `AuthGuard.tsx` and `src/App.tsx` are mt-frontend-brand-r3 paths (`.kiro/specs/mt-frontend-brand-r3/lanes/brand-surface-r3.md:15`, `.kiro/specs/mt-frontend-brand-r3/lanes/brand-surface-r3.md:22`); `src/App.tsx` also mt-tenant-admin-r2 (`.kiro/specs/mt-tenant-admin-r2/lanes/tenant-admin-pages.md:17`) | WS7, WS8 (landing SEO), M3 |
| WS11 | B2B Commerce Portal (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:124`) | MOD-COMMERCE (`vitanaland-strategy/02-PLATFORM/module-ownership.json:553`), MOD-VCAOP (`vitanaland-strategy/02-PLATFORM/module-ownership.json:529`), MOD-WALLET (`vitanaland-strategy/02-PLATFORM/module-ownership.json:473`) | `supplier_tenant_relationships` (`supabase/migrations/20261102120000_vtid_05488_supplier_tenant_relationships.sql:48`); platform tenant and `source = 'platform'` (`docs/MULTI-TENANT-PLAN.md:62`); the shared Discover predicate VTID-05486; one VTNA wallet (D2) | A second supplier-to-tenant mapping (VCAOP `partner_tenant` is backfilled into it, row 28); per-tenant wallets | `partner-onboarding.ts` and `partner-onboarding-service.ts` in two mt-discover-r2 lanes (`.kiro/specs/mt-discover-r2/lanes/supplier-onboarding-communities.md:11-12`, `.kiro/specs/mt-discover-r2/lanes/discover-shared-predicate.md:31`); `credit-recommender.ts` (`.kiro/specs/mt-discover-r2/lanes/supplier-onboarding-communities.md:14`); flag `mt.discover_tenant_gate` couples NULL-tenant sessions globally (`docs/multitenancy/MIGRATION-QUEUE.md:47`) | WS11 |
| WS12 | Exafy Back Office (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:133`) | MOD-BACKOFFICE (`vitanaland-strategy/02-PLATFORM/module-ownership.json:586`) | `requireTenantAdmin` / `requireExafyAdmin`; ERP bootstrap request (`supabase/migrations/20261102141000_vtid_05506_mt_provision_erp_request.sql:26`) | An admin role check; an ERP tenant map | `canManageRoles` (used by backoffice-access) checks `active_role` only (`services/gateway/src/lib/tenant-role-auth.ts:89`) while `requireTenantAdmin` also requires a permitted admin role (`services/gateway/src/middleware/require-tenant-admin.ts:143`); no lane owns `tenant-role-auth.ts`; mt-m3-r2 row 61 re-creates `provision_tenant()`; `monitoring-erp-gw` VTID-05503 | WS4, M3 |
| WS13 | Marketing Studio and Marketing Automation (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:141`) | MOD-MARKETING (`vitanaland-strategy/02-PLATFORM/module-ownership.json:618`) | Email branding (`vitana-v1/supabase/migrations/20261101090000_vtid_05245_tenant_email_branding.sql:104`); brand pack sender fields (`supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql:40-41`); job tenant loop for campaigns | A sender or brand store; `DEFAULT_TENANT_ID` dispatch | `queue-campaign-recipients` (a MOD-MARKETING path) is a Track S S-H finding (`docs/MULTI-TENANT-PLAN.md:44`); `send-welcome-discount` is an mt-frontend-brand path (`.kiro/specs/mt-frontend-brand/lanes/email-brand-code.md:13`); queue row 11 must apply first | WS7, WS8, WS-S |
| WS14 | Command Hub Modernisation (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:150`) | MOD-COMMAND-HUB (`vitanaland-strategy/02-PLATFORM/module-ownership.json:823`) | Admin tenants API (`services/gateway/src/routes/admin-tenants.ts:317`); `requirePlatformScope`; the tenant-admin module VTID-05489 | A second tenant admin UI or tenant picker | `app.js` in mt-tenant-admin-r2 (`.kiro/specs/mt-tenant-admin-r2/lanes/command-hub-tenant-module.md:15`), a hot file (`.kiro/specs/mt-frontend-brand/plan.md:181`); WS4 asks for a new module, not big `app.js` edits (`docs/MULTI-TENANT-PLAN.md:111`) | WS4, WS7 |
| WS15 | Healthy Million Complete Tenant Replication (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:162`) | MOD-DEST-PACKS (`vitanaland-strategy/02-PLATFORM/module-ownership.json:704`) | `POST /api/v1/admin/tenants` → `provision_tenant()`; readiness; packs (rows 8a, 9-10, 40); "mirror the platform, not the content" (`docs/MULTI-TENANT-PLAN.md:19`); HM readiness gates (`draft-05690/docs/programs/strategy-execution/healthy-million-readiness.md:425`, draft, not merged) | Replication tooling, copied Maxina content, a tenant creation path outside `provision_tenant()` | Rows 8a, 9, 10 pending in order (`docs/multitenancy/MIGRATION-QUEUE.md:26-28`); `tenant-registry.ts` (MOD-DEST-PACKS path) is read by theme-tokens-r3; VTID-05221 PR #1438 open | WS4, WS5, WS7, WS8 |
| WS16 | AI-Powered Tenant/Destination Builder (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:172`) | MOD-TENANT-BUILDER (`vitanaland-strategy/02-PLATFORM/module-ownership.json:795`) | The admin route, never the RPC directly (service_role only, `supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql:242-243`); pack intake and `get_tenant_launch_readiness` (`supabase/migrations/20261101110100_mt_launch_tenant_content_pipeline.sql:74`) | A provisioning RPC, pack schema or reserved-slug list | `admin-tenants.ts` in mt-tenant-admin-r2 (`.kiro/specs/mt-tenant-admin-r2/lanes/tenant-admin-api.md:11`); v1 provisioning UI in mt-m3-r2 (`.kiro/specs/mt-m3-r2/lanes/wizard-price-polish.md:12`); VTID-05221 | WS4, WS8 |
| WS17 | Autonomous Operations and Continuous Improvement (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:181`) | MOD-LOOPS (`vitanaland-strategy/02-PLATFORM/module-ownership.json:862`), MOD-AUTOPILOT-LOOP (`vitanaland-strategy/02-PLATFORM/module-ownership.json:890`), MOD-WORKER-ORCH (`vitanaland-strategy/02-PLATFORM/module-ownership.json:918`), MOD-DEV-AUTOPILOT (`vitanaland-strategy/02-PLATFORM/module-ownership.json:947`), MOD-VERIFY-ENGINE (`vitanaland-strategy/02-PLATFORM/module-ownership.json:981`), MOD-SELF-HEALING (`vitanaland-strategy/02-PLATFORM/module-ownership.json:1009`), MOD-SELF-IMPROVE (`vitanaland-strategy/02-PLATFORM/module-ownership.json:1049`), MOD-COMMUNITY-AUTOPILOT (`vitanaland-strategy/02-PLATFORM/module-ownership.json:1075`), MOD-SUPPORT (`vitanaland-strategy/02-PLATFORM/module-ownership.json:1099`) | `resolveJobTenants` / `loadActiveTenantContexts`; `mt.jobs_tenant_loop`; `ci_tenant_isolation_health()`; per-tenant support routing VTID-05325 | Per-job tenant iteration; new `DEFAULT_TENANT_ID` readers | `scan-runner.ts` (MOD-COMMUNITY-AUTOPILOT area) in mt-jobs (`.kiro/specs/mt-jobs/lanes/jobs-community-scan-tenant.md:13`); feedback routes in mt-launch support-landing (`.kiro/specs/mt-launch/lanes/support-landing.md:3`) | WS6, WS8, WS0 |
| WS18 | System Integration, Validation and Launch (`vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:198`) | MOD-VTID (`vitanaland-strategy/02-PLATFORM/module-ownership.json:1156`), MOD-OASIS (`vitanaland-strategy/02-PLATFORM/module-ownership.json:1188`), MOD-STAGING-VERIFY (`vitanaland-strategy/02-PLATFORM/module-ownership.json:1221`), MOD-DELIVERY (`vitanaland-strategy/02-PLATFORM/module-ownership.json:1254`), MOD-INTEGRATIONS-MCP (`vitanaland-strategy/02-PLATFORM/module-ownership.json:500`) | Isolation suite (VTID-05446, done), Maxina golden VTID-05448, ci-wiring VTID-05443; MT exit criteria (`docs/MULTI-TENANT-PLAN.md:20`); OASIS stays platform-scoped (`services/gateway/src/middleware/require-tenant-admin.ts:165-166`) | A second isolation suite, golden suite or tenant column on OASIS | `PR-GATE.yml` in mt-launch (`.kiro/specs/mt-launch/lanes/worker-test-gate.md:9`); `MORNING-SYSTEM-HEALTH-CHECK.yml` in mt-guardrails-r2 (`.kiro/specs/mt-guardrails-r2/lanes/ci-wiring.md:13`) | WS0, WS-S |

### 3.1 MT plan work streams → MT specs → WS03

| MT plan work stream | Line | MT specs at the pin | WS03 task |
|---|---|---|---|
| WS-S Security hotfixes (Track S) | `docs/MULTI-TENANT-PLAN.md:106` | mt-track-s-r2 (`.kiro/specs/mt-track-s-r2/plan.md:12`), mt-track-s-authz (`.kiro/specs/mt-track-s-authz/plan.md:7`) | SB-MT-04 record only |
| WS0 Guard rails & test env | `docs/MULTI-TENANT-PLAN.md:107` | mt-guardrails-r2 (`.kiro/specs/mt-guardrails-r2/plan.md:4`), mt-local-stack-replay-skips-r1 (done) | SB-MT-04 |
| WS1 Identity, resolution & roles | `docs/MULTI-TENANT-PLAN.md:108` | mt-identity-r2 (`.kiro/specs/mt-identity-r2/plan.md:4`); lane A VTID-05149 (applied rows 2-4) | SB-MT-02 (rows 12-20) |
| WS2 Data cleanup | `docs/MULTI-TENANT-PLAN.md:109` | mt-data-cleanup-r2 (`.kiro/specs/mt-data-cleanup-r2/plan.md:4`) | SB-MT-02 (rows 21-25, 37-42, 57-58) |
| WS3 Community isolation + Network | `docs/MULTI-TENANT-PLAN.md:110` | mt-network-r2 (`.kiro/specs/mt-network-r2/plan.md:4`); mt-community-isolation-r2 (PR #4582, not on main) | SB-MT-02 (rows 45-56, 63-65) |
| WS4 Provisioning & tenant admin | `docs/MULTI-TENANT-PLAN.md:111` | mt-tenant-admin-r2 (`.kiro/specs/mt-tenant-admin-r2/plan.md:4`); multi-tenant provisioning-ui VTID-05221 | SB-MT-01 |
| WS5 Assistant & content packs | `docs/MULTI-TENANT-PLAN.md:112` | mt-packs-r2 (`.kiro/specs/mt-packs-r2/plan.md:4`) | SB-MT-03 |
| WS6 Jobs & events | `docs/MULTI-TENANT-PLAN.md:113` | mt-jobs (`.kiro/specs/mt-jobs/plan.md:4`) | SB-MT-01 |
| WS7 Frontend tenant layer & brand | `docs/MULTI-TENANT-PLAN.md:114` | mt-frontend-brand (`.kiro/specs/mt-frontend-brand/plan.md:4`), mt-frontend-brand-r3 | SB-MT-03 |
| WS8 Tenant Launch | `docs/MULTI-TENANT-PLAN.md:115` | mt-launch (`.kiro/specs/mt-launch/plan.md:4`) | SB-MT-01 |
| WS9 Native app shell | `docs/MULTI-TENANT-PLAN.md:116` | mt-native-health-r2 native part (`.kiro/specs/mt-native-health-r2/plan.md:106`) | SB-MT-04 |
| WS10 Health data × tenancy | `docs/MULTI-TENANT-PLAN.md:117` | mt-native-health-r2 health part (`.kiro/specs/mt-native-health-r2/plan.md:106`) | SB-MT-02 (rows 43-44) |
| WS11 Commerce & Discover × tenancy | `docs/MULTI-TENANT-PLAN.md:118` | mt-discover-r2 (`.kiro/specs/mt-discover-r2/plan.md:4`) | SB-MT-02 (rows 26-29) |
| M3 items | `docs/MULTI-TENANT-PLAN.md:119` | mt-m3-r2 (`.kiro/specs/mt-m3-r2/plan.md:4`); queue bookkeeping mt-schema-queue-followup-r2 (done) | SB-MT-02 (rows 30-31, 61-62) |

## 4. Proposed follow-ups

Proposals only. Nothing below is done. Each follow-up uses an existing canonical contract from §1; none proposes a
new resolver, identity model, membership model or authorisation system. Each needs the owning spec's own plan
amendment or lane and its gates.

| ID | Title | Files | Owning MT spec | Gate |
|---|---|---|---|---|
| F1 | Route the six unowned local tenant lookups and the diary nil-tenant fallback through `resolvePrimaryTenant()` / `TenantContext` | `services/gateway/src/routes/memory-repository.ts:76`, `services/gateway/src/services/memory/diary.ts:138`, `services/gateway/src/routes/relationships-repository.ts:34`, `services/gateway/src/services/data-export-consent-repository.ts:20`, `services/gateway/src/services/orb-tools/chat-privacy-tools-repository.ts:18`, `services/gateway/src/services/orb-tools/groups-events-tools-repository.ts:21`, `services/gateway/src/services/orb-tools/marketplace-va-shared-repository.ts:29` | mt-identity-r2 (WS1 owns `resolvePrimaryTenant()`, `docs/MULTI-TENANT-PLAN.md:108`), as an amendment of `tenant-db-and-slug-cleanup` VTID-05468 | Plan sparring; dark behind `MT_RESOLUTION_V2`; Maxina golden VTID-05448 unchanged; gateway scope lint VTID-05444 |
| F2 | One `healthDb(userId)` file: reconcile the two planned locations | `.kiro/specs/mt-identity-r2/lanes/tenant-db-and-slug-cleanup.md:17`, `.kiro/specs/mt-native-health-r2/lanes/health-tenant-accessor.md:11` | mt-identity-r2 and mt-native-health-r2 jointly, as already done for `isHealthTable()` (`.kiro/specs/mt-native-health-r2/plan.md:94`) | Plan amendment of both specs before either lane builds |
| F3 | Make `canManageRoles` use the same permitted-admin check as `requireTenantAdmin` step 6 | `services/gateway/src/lib/tenant-role-auth.ts:79-89`, reference `services/gateway/src/middleware/require-tenant-admin.ts:143` | mt-identity-r2 (single role source, WS1) | Plan sparring; regression test for role-admin and backoffice-access; Track S class if live state (§5) shows `active_role` is still member-writable |
| F4 | Record a merge order for files shared across MT specs: `orb-tools-shared.ts` (mt-network-r2 ×2, mt-packs-r2), `services/gateway/src/index.ts` (mt-jobs, mt-launch ×2), `tenancy/tenant-context.ts` (mt-identity-r2, mt-m3-r2), health repositories (mt-discover-r2, mt-native-health-r2), `src/App.tsx` (mt-frontend-brand-r3, mt-tenant-admin-r2), `docs/SCREEN_INVENTORY.md` (7 lanes) | lane files cited in §2.1 | multi-tenant (programme spec), with each owning spec's plan driver | Hot-file sequencing rule (`.claude/rules/collaboration.md:358`); serialized landing |
| F5 | Refresh lane states: 3 stale (`jobs-community-scan-tenant`, `pack-intake-db`, `email-brand-db`, PRs merged) and 7 superseded or replaced (`brand-surface`, `theme-tokens`, `approvals-auth`, `work-surface-permission`, `s-j-retire-allowlist`, `local-test-stack`, `local-test-stack-v2`) | lane files cited in §2.1 | mt-jobs, mt-launch, mt-frontend-brand, mt-track-s-authz, mt-track-s-r2, mt-guardrails-r2; open plan PR #4920 covers the superseded close | Lane-admin process (collaboration.md §7a) |
| F6 | Retire `DOMAIN_TENANT_MAP` in favour of `tenant_domains` + `resolve_tenant(p_host, p_slug)` after rows 30-31 apply and `host-resolution-gw` lands | `vitana-v1/src/config/domain-tenant-mapping.ts:5`, `vitana-v1/src/components/AuthGuard.tsx:75`, `vitana-v1/src/lib/guest-auth.ts:25`, `vitana-v1/src/pages/ShareEntry.tsx:25` | mt-m3-r2 (host resolution), coordinated with mt-frontend-brand-r3 (owns `AuthGuard.tsx`); relates to draft D1/D2 (`draft-05689/docs/programs/strategy-execution/destination-identity-strategy.md:224`, draft, not merged) | Owner approval of rows 30-31; plan sparring; Maxina golden and domain-map test unchanged with the flag off |
| F7 | Update the programme plan: the "nothing in this file is built yet" status line and the Capacitor wording for WS9 | `docs/MULTI-TENANT-PLAN.md:3`, `docs/MULTI-TENANT-PLAN.md:60`, `docs/MULTI-TENANT-PLAN.md:116` | multi-tenant (programme plan owner); same as draft D6 | Plan PR with sparring (it is a plan-body change) |
| F8 | Add `repos:` / `paths:` front matter where missing, so protected paths are machine-readable | `.kiro/specs/multi-tenant/lanes/provisioning-ui.md:3` (no `paths:`); mt-jobs, mt-launch and mt-frontend-brand lane files (no `repos:`) | multi-tenant, mt-jobs, mt-launch, mt-frontend-brand | Lane-admin process |

Count per owning spec: mt-identity-r2 3 (F1, F2, F3), mt-native-health-r2 1 (F2), multi-tenant 3 (F4, F7, F8), mt-m3-r2 1
(F6), mt-frontend-brand-r3 1 (F6), mt-jobs 2 (F5, F8), mt-launch 2 (F5, F8), mt-frontend-brand 2 (F5, F8),
mt-track-s-authz 1 (F5), mt-track-s-r2 1 (F5), mt-guardrails-r2 1 (F5).

## 5. Unknowns that need live state

| Unknown | Why it matters | Read-only check (owner or exafy_admin) |
|---|---|---|
| Live body of `current_tenant_id()` | The MT plan says top-level claim only (`docs/MULTI-TENANT-PLAN.md:24`); the repo body also reads `app_metadata` and `user_tenants` (`supabase/migrations/20260218000000_fix_maxina_signup_tenant_association.sql:68-90`). It decides who the 32 bare policies admit today | `pg_get_functiondef`; VTID-05465 already guards on it at apply |
| RUN-MIGRATION run ids for rows 1-8 | VO rows above rely on the queue's record | Re-read the eight workflow runs |
| Which queue rows are live | Rows 8a-65 are marked not applied; drift is possible | `supabase_migrations.schema_migrations` read |
| Deployed `MT_RESOLUTION_V2` and `TENANT_MEMBERSHIP_CHECK_MODE` | Decide whether dark code runs and whether membership is enforced | ECS task definition read |
| `tenant_settings.feature_flags.mt.*` per tenant | Flags such as `mt.discover_tenant_gate` act globally for NULL-tenant sessions once one tenant enables them (`docs/multitenancy/MIGRATION-QUEUE.md:47`) | Select on `tenant_settings` |
| Bare-policy and tenant-table counts | Last count is 2026-10-10 (`docs/MULTI-TENANT-PLAN.md:24`) | `pg_policies` read; WS0 lint |
| Whether `active_role` is still member-writable | Sizes F3 (`services/gateway/src/middleware/require-tenant-admin.ts:143-145`) | Grants and policies on `user_tenants` |
| Access-token hook state (D14) | Rows 17-18 add the shadow hook; enabling it is an auth-config step | Supabase auth hook config |
| Lane and PR state after 2026-11-11 | §2 is a snapshot | Re-run the `gh api` reads in `commands.log` |
