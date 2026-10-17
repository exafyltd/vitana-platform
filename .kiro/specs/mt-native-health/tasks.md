# Tasks — mt-native-health (WS9 native tenancy delta + WS10 health-×-tenancy contract)

Program: MULTI-TENANT-PLAN §6 (WS9/WS10). Companion `health-native` (VTID-05020/05021) owns the native shell, screen
ports, builds and Health Hub phases; this spec is the tenancy delta only. VTID: allocated by PLAN-SPAR after approval.
Acceptance for every lane: its own PR checks green (incl. Lane scope), no writes to staging/production, dark by default,
read-only `docs/validation/<VTID>/staging-tests.json` for anything that deploys.

## switch-tenant-rpc-db — switch_active_tenant RPC + reserved slugs + transport flag (repo vitana-platform)
<!-- lane: switch-tenant-rpc-db -->
Allowed paths:
- supabase/migrations/20261101130000_mt_native_health_switch_tenant_rpc.sql
- supabase/migrations/*mt_native_health_switch_tenant_rpc*rollback*.sql
- docs/multitenancy/MIGRATION-QUEUE.md
- test/db/mt-native-health-switch-tenant.sql

- [ ] SECURITY DEFINER `switch_active_tenant(p_slug text)`: caller from `auth.uid()`, validate `user_tenants`
      membership, set the `active_tenant_id` preference; raise on non-member, unknown slug, reserved slug.
- [ ] `reserved_tenant_slugs(slug text primary key)` seeded from `vitana-v1/src/navigation/registry/screens.json`
      top-level routes; `provision_tenant` rejects a reserved slug.
- [ ] `user_device_tokens.transport text CHECK (transport IN ('appilix','native'))` + partial unique index enforcing one
      active transport-owner per device (VTID-03481 invariant).
- [ ] `REVOKE EXECUTE … FROM PUBLIC`; `EXECUTE` to the caller role only; `lock_timeout`; expand/contract.
- [ ] Pre-approved rollback migration; read-only `live-before.sql` + `post-apply-checks.sql` in docs/validation.
- [ ] MIGRATION-QUEUE rows appended after row 8 (order: switch-tenant-rpc-db → health-home-tenant-db), with cross-spec
      depends-on (`mt-identity`, A-M1 `20261014000100`).
- [ ] pgTAP: non-member rejected; reserved slug rejected; member preference set; transport one-owner holds on
      re-registration.
Acceptance: migration + rollback apply cleanly on the D11 local stack; pgTAP green; no live apply by the executor.

## native-tenant-switch — client switch + picker/join + universal-link routing (repo vitana-v1)
<!-- lane: native-tenant-switch -->
Allowed paths:
- apps/mobile/src/identity/**
- apps/mobile/src/screens/tenant/**
- apps/mobile/app/+native-intent.tsx
- apps/mobile/app/(public)/**
- apps/mobile/tests/tenant-switch.test.tsx
- apps/mobile/parity/ledger.json

- [ ] `switchActiveTenant(slug)` calls `switch_active_tenant` → `refreshSession()` → gate tenant-data queries until the
      claim's `tenant_id` matches the target (TenantProvider).
- [ ] Device-stored last tenant is only an input, re-validated server-side on launch.
- [ ] In-app community picker (`list_public_tenants`) + "join this community" screen for non-members.
- [ ] `app/+native-intent.tsx` routes a `/<slug>` universal link to the switch; never a silent Maxina default.
- [ ] No Maxina constant beyond store identifiers (D16); 11 locales DE-first du-form + RTL; parity ledger synced.
- [ ] Vitest: switch waits for the matching claim before fetching; a tenant-B deep link for a tenant-A-only member
      lands on the join screen with no data fetched.
Acceptance: tests green against the fake gateway / local stack; no switch RPC call against a live system.

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

- [ ] `app_users.health_home_tenant_id uuid REFERENCES tenants`; backfill to each user's current primary membership
      (batched/off-peak); set-once.
- [ ] BEFORE-INSERT trigger sets it at the first health write for new users; never changed on `is_primary` change.
- [ ] Health table membership referenced via `mt-identity`'s `isHealthTable()` (CROSS-SPEC O1) — no local list.
- [ ] Pre-approved rollback; read-only `live-before.sql` + `post-apply-checks.sql`; `lock_timeout`; expand/contract.
- [ ] MIGRATION-QUEUE row appended after switch-tenant-rpc-db's row.
- [ ] pgTAP: `health_home_tenant_id` set-once; unchanged on `is_primary` change; backfill matches current primary.
Acceptance: migration + rollback apply cleanly on the local stack; pgTAP green; no live apply by the executor.

## health-db-accessor — healthDb(userId) + TENANT_TABLES exclusion + reader/writer conversion (repo vitana-platform)
<!-- lane: health-db-accessor -->
Allowed paths:
- services/gateway/src/services/health/health-db.ts
- services/gateway/src/services/health/**
- services/gateway/src/repositories/integrations-repository.ts
- services/gateway/src/repositories/diary-health-extractor-repository.ts
- services/gateway/src/repositories/health-repository.ts
- services/gateway/src/repositories/health-wellness-repository.ts
- services/gateway/src/repositories/health-action-initiative-repository.ts
- services/gateway/test/services/mt-native-health-healthdb.test.ts

- [ ] `healthDb(userId)` resolves `health_home_tenant_id` itself; it is the only path to health tables.
- [ ] Health tables EXCLUDED from `mt-identity`'s `TENANT_TABLES`.
- [ ] Convert the §4.9 session-tenant readers/writers (re-verify each path at build time) to `healthDb`.
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
