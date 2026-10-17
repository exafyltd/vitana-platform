# Tasks — mt-native-health (WS9 native tenancy delta + WS10 health-×-tenancy contract)

Program: MULTI-TENANT-PLAN §6 (WS9/WS10). Companion `health-native` (VTID-05020/05021) owns the native shell, screen
ports, builds and Health Hub phases; this spec is the tenancy delta only. VTID: allocated by PLAN-SPAR after approval.
Acceptance for every lane: its own PR checks green (incl. Lane scope), no writes to staging/production, dark by default,
read-only `docs/validation/<VTID>/staging-tests.json` for anything that deploys.

## switch-tenant-rpc-db — transport one-owner flag (DB); reuse existing switch RPC (repo vitana-platform)
<!-- lane: switch-tenant-rpc-db -->
Allowed paths:
- supabase/migrations/20261101130000_mt_native_health_transport_flag.sql
- supabase/migrations/*mt_native_health_transport_flag*rollback*.sql
- docs/multitenancy/MIGRATION-QUEUE.md
- test/db/mt-native-health-transport-flag.sql

Do NOT create a `switch_active_tenant` RPC or a `reserved_tenant_slugs` table: the switch RPC
(`switch_to_tenant_by_slug`, `20261010180200`, VTID-05043) and reserved slugs (`20261014000400`/`20261014000500`,
VTID-05150) already exist and are applied. Do NOT re-seed reserved slugs from the cross-repo
`vitana-v1/src/navigation/registry/screens.json` (`scripts/tenants/gen-reserved-slugs.mjs` +
`TENANT-RESERVED-SLUGS-DRIFT.yml` already keep the applied table synced).

- [ ] `user_device_tokens.transport text CHECK (transport IN ('appilix','native'))` + partial unique index enforcing one
      active transport-owner per device (VTID-03481 invariant). `lock_timeout`; expand/contract.
- [ ] ONLY if a real switch-RPC gap is confirmed at build time (none known — `TenantProvider.tsx:116` already maps
      42501 → `not_joinable`): extend `switch_to_tenant_by_slug` in place via `CREATE OR REPLACE`, keeping its
      `GRANT EXECUTE … TO authenticated` / `REVOKE … FROM PUBLIC, anon` grants. Never a parallel RPC.
- [ ] Pre-approved rollback migration; read-only `live-before.sql` + `post-apply-checks.sql` in docs/validation.
- [ ] MIGRATION-QUEUE rows appended after row 8 (order: switch-tenant-rpc-db → health-home-tenant-db), with cross-spec
      depends-on (`mt-identity`, A-M1 `20261014000100`).
- [ ] pgTAP: transport one-owner holds on re-registration (one active transport per device).
Acceptance: migration + rollback apply cleanly on the D11 local stack; pgTAP green; no live apply by the executor; no
`switch_active_tenant`/`reserved_tenant_slugs` re-creation.

## native-tenant-switch — client switch + picker/join + universal-link routing (repo vitana-v1)
<!-- lane: native-tenant-switch -->
Allowed paths:
- apps/mobile/src/identity/**
- apps/mobile/src/screens/tenant/**
- apps/mobile/app/+native-intent.tsx
- apps/mobile/app/(public)/**
- apps/mobile/tests/tenant-switch.test.tsx
- apps/mobile/parity/ledger.json

The client switch already exists: `TenantProvider.tsx:112-126` calls `switch_to_tenant_by_slug`, maps 42501 →
`not_joinable`, does `refreshSession()`, gates on the new claim and re-validates the stored slug. Build ONLY the delta
below; do not add a parallel switch or a new RPC.

- [ ] In-app community picker (`list_public_tenants`) + "join this community" screen reached on the `not_joinable`
      return from the existing `switchActiveTenant`.
- [ ] `app/+native-intent.tsx` routes a `/<slug>` universal link to the existing switch; never a silent Maxina default.
- [ ] Device-stored last tenant stays an input, re-validated server-side on launch (already in TenantProvider — extend
      only if the picker/join flow needs it).
- [ ] No Maxina constant beyond store identifiers (D16); 11 locales DE-first du-form + RTL; parity ledger synced.
- [ ] Vitest: a tenant-B deep link for a tenant-A-only member lands on the join screen with no tenant data fetched;
      the picker lists public tenants and switches via the existing path.
Acceptance: tests green against the fake gateway / local stack; no switch RPC call against a live system; no duplicate
client switch added.

## push-tenant-fanout — per-tenant push fan-out, fetch tokens by user_id (repo vitana-platform)
<!-- lane: push-tenant-fanout -->
Allowed paths:
- services/gateway/src/routes/notifications.ts
- services/gateway/src/routes/notifications-repository.ts
- services/gateway/src/services/notification-service.ts
- services/gateway/src/services/notification-service-repository.ts
- services/gateway/test/services/mt-native-health-push-fanout.test.ts

- [ ] `upsertDeviceToken` no longer writes `tenant_id` (expand/contract: column kept, not load-bearing for delivery).
- [ ] `fetchLiveDeviceTokensForUser` / `sendPushToUser` fetch by `user_id` only; per-tenant copy + deep link derived
      from the notification row's `tenant_id`; transport flag honoured (one transport per device).
- [ ] Dark behind `tenant_settings.feature_flags.mt.native_push_tenant_fanout`.
- [ ] Contract test: `ab_dual` receives pushes from BOTH tenants with per-tenant copy (fake Supabase / local stack).
- [ ] `npm run test:support` green; Maxina golden push copy unchanged.
Acceptance: tests green; no sign-in probe or push against production.

## health-home-tenant-db — app_users.health_home_tenant_id + backfill + set-once (repo vitana-platform)
<!-- lane: health-home-tenant-db -->
Allowed paths:
- supabase/migrations/20261101131000_mt_native_health_home_tenant.sql
- supabase/migrations/*mt_native_health_home_tenant*rollback*.sql
- docs/multitenancy/MIGRATION-QUEUE.md
- test/db/mt-native-health-home-tenant.sql

- [ ] `app_users.health_home_tenant_id uuid REFERENCES tenants`; backfill set-once (batched/off-peak) by a
      deterministic rule: the user's `is_primary=true` `user_tenants` row; when none/ambiguous, the
      `is_default`/`is_platform` tenant the user belongs to, else the oldest `user_tenants` row by `created_at`
      (same tie-break as `20261014000200_vtid_05149_signup_default_tenant.sql`).
- [ ] BEFORE-INSERT trigger sets it at the first health write for new users; never changed on `is_primary` change.
- [ ] Health table membership referenced via `mt-identity`'s `isHealthTable()` (CROSS-SPEC O1) — no local list.
- [ ] Pre-approved rollback; read-only `live-before.sql` + `post-apply-checks.sql`; `lock_timeout`; expand/contract.
- [ ] MIGRATION-QUEUE row appended after switch-tenant-rpc-db's row.
- [ ] pgTAP: `health_home_tenant_id` set-once; unchanged on `is_primary` change; the backfill tie-break resolves
      exactly one row per user (including users with zero/multiple primary rows).
Acceptance: migration + rollback apply cleanly on the local stack; pgTAP green; no live apply by the executor.

## health-db-accessor — healthDb(userId) + TENANT_TABLES exclusion + reader/writer conversion (repo vitana-platform)
<!-- lane: health-db-accessor -->
Allowed paths:
- services/gateway/src/services/health-db.ts
- services/gateway/src/routes/integrations-repository.ts
- services/gateway/src/routes/health-repository.ts
- services/gateway/src/services/automation-handlers/health-wellness-repository.ts
- services/gateway/src/services/automation-handlers/health-action-initiative-repository.ts
- services/gateway/src/services/diary-health-extractor-repository.ts
- services/gateway/test/services/mt-native-health-healthdb.test.ts

- [ ] `healthDb(userId)` (new file `services/gateway/src/services/health-db.ts`) resolves `health_home_tenant_id`
      itself; it is the only path to health tables.
- [ ] Health tables EXCLUDED from `mt-identity`'s `TENANT_TABLES`.
- [ ] Convert the §4.9 session-tenant readers/writers at their REAL paths (`routes/integrations-repository.ts`,
      `routes/health-repository.ts`, `services/automation-handlers/health-wellness-repository.ts`,
      `services/automation-handlers/health-action-initiative-repository.ts`,
      `services/diary-health-extractor-repository.ts`; re-verify each at build time) to `healthDb`.
- [ ] State whether `healthDb` subsumes `resolveHealthTenantId()`
      (`services/gateway/src/services/orb-tools/health-depth-tools.ts:118`) so the two resolvers do not diverge.
- [ ] Generated inventory + lint fails the build on any health reader/writer that bypasses `healthDb`.
- [ ] Dark behind `mt.health_home_tenant`.
- [ ] Vitest: `ab_dual` in a tenant-B session writes and reads the same single health series.
Acceptance: tests green; lint fails on a seeded bypass; no live writes.

## ota-compat-gate — OTA min_native_version compatibility gate (repo vitana-v1)
<!-- lane: ota-compat-gate -->
Allowed paths:
- apps/mobile/src/ota/**
- apps/mobile/src/updates/**
- apps/mobile/tests/ota-compat.test.ts
- apps/mobile/parity/ledger.json

- [ ] OTA bundle manifest declares `min_native_version` + required plugin versions.
- [ ] Shell reports its version/plugins at startup and on device registration.
- [ ] Update client refuses an incompatible bundle and keeps the last compatible one.
- [ ] Native-dependent features gated by runtime capability detection, not bundle version.
- [ ] Vitest: old-binary fixture → incompatible bundle refused, last compatible kept.
Acceptance: tests green; OTA channel promotion left owner-gated (D19), out of this lane.

## lineage-guard-health — D18 analytics guard + ORB health/commerce dispatcher rule (repo vitana-platform, executor claude)
<!-- lane: lineage-guard-health -->
Allowed paths:
- .github/workflows/mt-native-health-lineage-guard.yml
- services/gateway/src/orb/live/tools/health-commerce-dispatch-guard.ts
- services/gateway/test/guards/mt-native-health-lineage-guard.test.ts
- services/gateway/test/orb/mt-native-health-dispatch.test.ts

- [ ] Build-failing guard test (commerce arch §7.2 pattern): no tenant-admin/tenant-owner analytics surface reads
      `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*` (D18).
- [ ] Re-verify whether `health-native` already ships the ORB health/commerce dispatcher rule; if not, enforce it in the
      tool dispatcher (not the declared catalog), covering `use_tool`, proven on Nova and the Vertex Serbian bridge.
- [ ] `npm run test:roles` green when the ORB dispatcher is touched; no spoken sentence hardcoded (rule 41).
- [ ] Workflow wiring runs the guard in CI.
Acceptance: guard test red on a seeded violation, green otherwise; ORB dispatch tests green on both pipelines; executor
claude, reviewed by a Kiro seat.
