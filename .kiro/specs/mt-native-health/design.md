# Design — mt-native-health

Authoritative plan: `plan.md`. This file records what exists today (with file refs), the design per lane, and the
rules every successor follows.

## What exists today (verified at the branch tip, 2026-10-15)
- **Health identity is tenant-keyed and session-written.**
  `services/gateway/src/routes/integrations-repository.ts:85` and
  `services/gateway/src/services/diary-health-extractor-repository.ts:24` upsert `health_features_daily` on
  `onConflict: 'tenant_id,user_id,date,feature_key'`. The tenant is a `limit(1).maybeSingle()` session fallback
  (`integrations-repository.ts:67-68`, `services/gateway/src/routes/health-repository.ts:68-69`). Readers take the
  session `tenantId` (`services/gateway/src/services/automation-handlers/health-wellness-repository.ts:44,50`;
  `.../health-action-initiative-repository.ts:54,60`).
- **No frozen home tenant, accessor, table list or predicate exists.** `health_home_tenant_id`, `healthDb`,
  `TENANT_TABLES`, `isHealthTable` have zero matches in `services/gateway/src` and `supabase/migrations`.
- **Native push partly built.** `services/gateway/src/routes/notifications.ts:62-117` registers a token and writes
  `tenant_id: identity.tenant_id` (`:107-110`); `user_device_tokens_one_active_owner` keeps one active row per
  (user, token); VTID-05177 added native token fields and `NATIVE_PUSH_DIRECT_ENABLED` (`:32,71-78`).
- **Native app is Expo/React Native, already tenant-aware.** vitana-v1 `apps/mobile/` has
  `src/identity/TenantProvider.tsx`, `src/identity/tenant-registry.ts`, `src/identity/useMemberships.ts`,
  `src/push/registration.ts`, `src/linking/resolve-link.ts`, `app/+native-intent.tsx`, and Maestro tenant/deep-link
  flows (`maestro/shell/08-tenants.yaml`, `10-deep-link-admin.yaml`). This is NOT the Capacitor shell the program
  plan assumed; the drift is recorded in `handoff.md` and `plan.md`.

## Design per lane

### health-home-tenant-db (DB)
`app_users.health_home_tenant_id uuid NULL REFERENCES tenants(id)`, indexed. A STABLE SECURITY DEFINER function
`health_home_tenant_id(p_user uuid)` returns `coalesce(app_users.health_home_tenant_id, <primary user_tenants row>)`
over the unique `(tenant_id, user_id)` index, never reading `app_metadata`. Backfill sets the column from each
member's current primary membership in batches (`lock_timeout`, off-peak), snapshotting to a `bak_*` table kept 30
days. Members with 0 or 2+ primary memberships are left NULL and listed by the pre-check for quarantine. Expand only;
no read path changes in this lane.

### health-tenant-accessor (gateway)
`healthDb(userId)` wraps the service-role client and resolves the frozen home tenant via `health_home_tenant_id()`,
injecting it into health reads/writes so no caller supplies a session tenant. The four verified repos plus
`health-repository.ts` are converted to call it. A generated inventory (grep of `.from('<health table>')` across
`services/gateway/src`, table set = `isHealthTable()` from mt-identity) feeds a build-failing lint: every health
read/write must route through `healthDb`, with an allowlist for the accessor and service-role platform jobs. Dark
behind `MT_RESOLUTION_V2`; off = today's session-tenant behaviour.

### health-analytics-lineage-guard (gateway)
A build-failing guard test over a generated inventory of tenant-analytics + commerce reader modules
(tenant-admin overview/KPIs/health-index, tenant-owner analytics, exports, Discover feed/search, ORB product/cart
tools, autopilot offers). It asserts none reads a table in `isHealthTable()`. Member-coaching modules are an explicit
exempt list. pgTAP companion: a T_B tenant admin reads zero health rows. The forbidden-table set is referenced from
mt-identity, never re-listed here (CROSS-SPEC O1).

### native-push-tenant (gateway)
Token fetch keyed by `user_id` only; push copy/deep link derived from the notification row's `tenant_id`; one active
transport per device preserved. Dark behind `NATIVE_PUSH_DIRECT_ENABLED` (native transport) and `MT_RESOLUTION_V2`
(per-tenant delivery read path). Contract test: ab_dual, one device, a push from each tenant with correct copy/link.

### native-tenant-isolation-tests (vitana-v1 apps/mobile)
Jest/contract tests on the existing app via the fake-gateway/fixture harness (`tests/helpers/`): claim-only tenant
resolution; non-member deep link → "join" with no tenant fetch; push registration sends only `user_id` identity. No
new screens, no production calls.

## Rules every successor follows
- **Health data belongs to the member, never the tenant.** Reads/writes use the frozen `health_home_tenant_id`, not
  the session tenant. Never add a tenant-analytics or commerce reader of a health table — the lineage guard fails the
  build; member-coaching readers are the only exemption and must be added to the exempt list with a one-line reason.
- **Reference mt-identity's `isHealthTable()`; never maintain a second health-table list** (CROSS-SPEC O1). Adding a
  health table extends that predicate in mt-identity's lane, with a stated dependency.
- **The JWT claim is the only tenant resolution source in the native app.** A deep-link slug or device-stored tenant
  is an input to a server-validated switch, never authoritative. A non-member deep link fetches no tenant data.
- **Per-tenant push comes from the notification row's tenant**, not the device token's stored tenant; tokens are
  fetched by `user_id`; one active transport per device.
- Dark by default (`MT_RESOLUTION_V2`, `NATIVE_PUSH_DIRECT_ENABLED`). DB changes follow the §4.7 expand/contract
  protocol, applied by Claude via RUN-MIGRATION; Kiro never applies a migration or writes to a live system.
- Never test against production; staging specs read-only. Every DB migration adds its row to
  `docs/multitenancy/MIGRATION-QUEUE.md` in the same PR, after mt-identity's membership-unification rows.
