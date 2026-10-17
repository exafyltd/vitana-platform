# Design — mt-native-health (WS9 native tenancy delta + WS10 health-×-tenancy contract)

## What exists today (verified 2026-10-15, current file:line)
- **Push:** `routes/notifications.ts:108-110` upserts `user_device_tokens` with `tenant_id: identity.tenant_id`,
  conflict `(user_id, fcm_token)` (`routes/notifications-repository.ts:29-52`). Delivery:
  `notification-service-repository.ts:38-42` `fetchLiveDeviceTokensForUser` filters
  `.eq('user_id', userId).eq('tenant_id', tenantId)`; `notification-service.ts:380-411` `sendPushToUser(userId,
  tenantId, …)`. `device_type` (`ios_native|android_native`, VTID-05177) and the
  `user_device_tokens_one_active_owner` index already exist.
- **Native app (vitana-v1 `apps/mobile`):** `app.config.ts` (identifiers end `.dev`; store ids `com.exafy.maxina`,
  `com.vitanaland.app` only after G3; scheme `maxina`), `app/_layout.tsx` (TenantProvider at :26,51), `app/index.tsx`
  (redirect `/home`|`/maxina`), `app/+native-intent.tsx` (single system-link resolver, VTID-05178),
  `app/(public)/maxina.tsx`+`alkalma.tsx` (PortalScreen), `parity/ledger.json`, remote-config/push/link modules
  (VTID-05178). No `switchActiveTenant`, no in-app picker/join, no OTA `min_native_version` gate.
- **DB/gateway (what ALREADY exists — reused, not rebuilt):** `switch_to_tenant_by_slug(p_tenant_slug text)` live and
  hardened (`20261010180200_vtid_05043_…:38-127`, SECURITY DEFINER, membership-validated, sets `active_tenant_id`,
  grants `authenticated`); `reserved_tenant_slugs` + `provision_tenant` `RESERVED_SLUG` guard + `reserved-slugs.ts`
  pre-check + `gen-reserved-slugs.mjs`/`TENANT-RESERVED-SLUGS-DRIFT.yml` sync (VTID-05150, `20261014000400`:129-170 /
  `20261014000500`:124); `provision_tenant` (`20261014000500`); `tenants.is_default`/`is_platform`
  (`20261014000100`). **What does NOT exist yet (this spec's deltas):** no `app_users.health_home_tenant_id`, no
  `healthDb`, no `user_device_tokens.transport` flag (grep: 0 hits); `tenantDb`/`TENANT_TABLES`/`isHealthTable()` are
  introduced by `mt-identity` (dependency). There is NO `switch_active_tenant` RPC and this spec does not add one.

## Design per lane

### native-tenant-switch (vitana-v1 apps/mobile)
The client switch is ALREADY built: `src/identity/TenantProvider.tsx:112-126` exposes `switchActiveTenant(slug)` →
`supabase.rpc('switch_to_tenant_by_slug', { p_tenant_slug })` (maps error 42501 → `not_joinable`) →
`refreshSession()` → reads the new `active_tenant_id` claim → `setActiveTenantId` → stores the slug and gates
tenant-data queries. This lane adds ONLY the delta: a community picker screen listing `list_public_tenants` (registry,
VTID-05151), a "join this community" screen reached on `not_joinable`, and `app/+native-intent.tsx` routing a
`/<slug>` universal link to the existing `switchActiveTenant`. No parallel switch, no new RPC, no silent Maxina
default. No new Maxina constant (D16).

### switch-tenant-rpc-db (vitana-platform DB)
The active-tenant switch RPC already exists — `public.switch_to_tenant_by_slug(p_tenant_slug text)`
(`20261010180200_vtid_05043_…`): SECURITY DEFINER, caller from `auth.uid()`, validates `user_tenants` membership,
joins only `open_signup` tenants else raises `TENANT_NOT_JOINABLE` (42501), raises on unknown slug, sets
`auth.users.raw_app_meta_data->'active_tenant_id'` (the store the access-token hook reads). Reserved slugs are already
enforced by VTID-05150 (`reserved_tenant_slugs` + `provision_tenant` `RESERVED_SLUG`). This lane therefore creates
NEITHER. Migration `20261101130000` adds ONLY `user_device_tokens.transport text CHECK (transport IN
('appilix','native'))` + a partial unique index enforcing one active transport-owner per device. IF a real switch-RPC
gap is confirmed at build time (none is known), extend `switch_to_tenant_by_slug` in place via `CREATE OR REPLACE`,
keeping its grants exactly — `GRANT EXECUTE ON FUNCTION … TO authenticated` and `REVOKE EXECUTE … FROM PUBLIC, anon`
(`20261010180200:126-127`) — never a parallel RPC. Expand/contract; `lock_timeout`; rollback migration; read-only
pre/post checks.

### push-tenant-fanout (vitana-platform gateway)
`upsertDeviceToken` stops writing `tenant_id` (expand/contract: column kept, no longer load-bearing);
`fetchLiveDeviceTokensForUser` and `sendPushToUser` fetch by `user_id` only; per-tenant copy and deep link derived from
the notification row's `tenant_id`; transport flag honoured so one transport serves a device. Dark behind
`mt.native_push_tenant_fanout`.

### health-home-tenant-db (vitana-platform DB)
Migration `20261101131000`: `app_users.health_home_tenant_id uuid REFERENCES tenants`, backfilled set-once (batched,
off-peak) by a deterministic rule — the user's `is_primary=true` `user_tenants` row; when none/ambiguous, the
`is_default`/`is_platform` tenant the user belongs to, else the oldest `user_tenants` row by `created_at` (the same
tie-break `20261014000200_vtid_05149_signup_default_tenant.sql` uses), so the pgTAP "backfill matches current primary"
assertion is well-defined for every user. BEFORE-INSERT trigger on the first health write sets it for new users and
never changes it on `is_primary` change. Health table set referenced via `mt-identity`'s `isHealthTable()`
(CROSS-SPEC O1 — no local list). Expand/contract; rollback; read-only pre/post checks.

### health-db-accessor (vitana-platform gateway)
`healthDb(userId)` — a new accessor at `services/gateway/src/services/health-db.ts` (there is no `services/health/`
dir) — resolves `health_home_tenant_id` itself and is the only path to health tables; health tables EXCLUDED from
`TENANT_TABLES`; convert the named session-tenant readers/writers at their REAL paths:
`routes/integrations-repository.ts`, `routes/health-repository.ts`,
`services/automation-handlers/health-wellness-repository.ts`,
`services/automation-handlers/health-action-initiative-repository.ts`,
`services/diary-health-extractor-repository.ts` (verified 2026-10-17; there is no `services/gateway/src/repositories/`
dir) to `healthDb`; a generated inventory + lint routes every health reader/writer through it and fails the build on a
bypass. The existing ORB resolver `resolveHealthTenantId()`
(`services/gateway/src/services/orb-tools/health-depth-tools.ts:118`, a session/`user_tenants` resolver for ORB health
writes) is reconciled with `healthDb` — the frozen-home-tenant rule is authoritative; the lane states whether ORB
writes move onto `healthDb` or why they stay, so the two resolvers do not diverge. Dark behind `mt.health_home_tenant`.
The accessor is injected at the repository layer only; the calling routes/services are unchanged in this lane — a
reviewer should expect edits only in the `*-repository.ts` modules and the new `health-db.ts`.

### ota-compat-gate (vitana-v1 apps/mobile)
OTA bundle manifest declares `min_native_version` + required plugin versions; the shell reports its version/plugins at
startup and on device registration; the update client refuses an incompatible bundle and keeps the last compatible one;
native-dependent features (HealthKit, Health Connect, native push, transport flag) gated by runtime capability
detection. Old-binary fixture test.

### lineage-guard-health (vitana-platform governance — executor claude)
Build-failing guard test modelled on commerce architecture §7.2: no tenant-admin/tenant-owner analytics surface reads
`health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*` (D18). ORB tool-dispatcher health/commerce rule (Apple
5.1.3) enforced in the dispatcher (not the declared catalog), covering `use_tool`, proven on Nova and the Vertex Serbian
bridge — only if `health-native` has not already shipped it (re-verify). Governance paths (`.github/**` /workflow and the
guard wiring) make this an `executor: claude` lane.

## Rules every successor follows
- Never test against production; staging specs read-only; native runtime verification on the D11 local stack / fixture
  tenants and the `vitana-mobile-testing` skill; the only production native check is a read-only build/health GET.
- Health data belongs to the member: use the frozen home tenant for every health read/write; health tables are excluded
  from `TENANT_TABLES`; no tenant-admin/analytics surface ever reads a health table (D18).
- Reference `mt-identity`'s `isHealthTable()` predicate; never maintain a local health-table list (CROSS-SPEC O1).
- No hardcoded spoken sentence (rule 41); push/UI/email strings via `tt()`/`{{brand}}`; i18n DE-first du-form + RTL for
  all 11 locales; Spotlight contract for web screens; nav registry / screen manifest / native parity ledger when
  `App.tsx` routes are added; What's New only for finished member features.
- Dark by default (`mt.*` flags + `MT_RESOLUTION_V2`); DB applied by Claude via RUN-MIGRATION after merge; owner
  approves each apply.
- No Maxina constant in native tenancy surfaces beyond immutable store identifiers (D16).
- Bedrock-only AI; no Google beyond the carve-outs; the ORB rule is enforced in the dispatcher, not the prompt.
- Each lane adds its own `docs/validation/<vtid>/` (plan-sparring copy, scope.json, staging-tests.json); not listed in
  lane `paths`.
