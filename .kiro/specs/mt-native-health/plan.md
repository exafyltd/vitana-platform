---
change_class: standard
---
# mt-native-health — WS9 native tenancy delta + WS10 health-×-tenancy contract

<!-- plan:begin -->
## Problem
This spec plans ONLY the multi-tenant delta on top of the already-approved `health-native` spec
(VTID-05020/05021). The native app and Health Hub features themselves (shell, screen ports, EAS builds,
Health Hub phases) are owned by `health-native` and are NOT re-planned here. Every premise below was
re-verified in current code (2026-10-15).

1. **Device-token tenant is overwritten per registration (dual-member push loss).**
   `services/gateway/src/routes/notifications.ts:108-110` upserts `user_device_tokens` with
   `tenant_id: identity.tenant_id`, conflict target `(user_id, fcm_token)`
   (`routes/notifications-repository.ts:29-52`). Delivery filters by the notification's tenant:
   `fetchLiveDeviceTokensForUser` does `.eq('user_id', userId).eq('tenant_id', tenantId)`
   (`services/notification-service-repository.ts:38-42`) and `sendPushToUser(userId, tenantId, …)`
   fetches with it (`services/notification-service.ts:380-411`). A dual member registering in tenant B
   rewrites the single row's `tenant_id` to B, so tenant-A pushes match zero rows and are silently lost.
2. **No server-side active-tenant switch for the app.** No `switch_active_tenant(slug)` RPC exists
   (grep: 0 hits in `services/gateway/src/**` and `supabase/migrations/**`). The native app resolves tenant
   from the JWT claim only; it has `TenantProvider` (`apps/mobile/src/identity/TenantProvider.tsx`,
   referenced `apps/mobile/app/_layout.tsx:26,51`) and portal screens `apps/mobile/app/(public)/maxina.tsx`,
   `alkalma.tsx`, but no in-app picker/join and no device-stored-last-tenant validated server-side.
3. **Reserved slugs are not enforced for the app's path/deep-link slugs.** `provision_tenant` (B lane,
   migration `20261014000500`) exists but there is no reserved-slug list derived from
   `vitana-v1/src/navigation/registry/screens.json` top-level routes enforced on tenant creation.
4. **No per-device transport one-owner flag.** `user_device_tokens` has `device_type`
   (`ios_native|android_native`, VTID-05177) but no `appilix|native` transport flag with a one-owner
   invariant per device (the Appilix→native cutover guarantee). `user_device_tokens_one_active_owner`
   (one active row per token) exists already (`routes/notifications.ts:95-97`).
5. **Health identity is keyed by session tenant, not a frozen home tenant.** `app_users` has no
   `health_home_tenant_id` column (grep: 0 hits). Health readers/writers use the session tenant today
   (per MULTI-TENANT-PLAN §4.9: `integrations-repository.ts:84`, `diary-health-extractor-repository.ts:24`,
   `health-repository.ts:52`, `health-wellness-repository.ts:44,50`, `health-action-initiative-repository.ts:54`).
   A dual member in a tenant-B session would write/read a different health series than in tenant A, because
   `health_features_daily UNIQUE (tenant_id, user_id, …)` keys on tenant.
6. **No `healthDb(userId)` accessor and no `TENANT_TABLES` exclusion for health.** Neither `healthDb` nor
   `TENANT_TABLES` exists yet (grep: 0 hits) — `tenantDb`/`TENANT_TABLES` are introduced by `mt-identity`.
   Health tables must be EXCLUDED from `TENANT_TABLES` and reached only through a user-keyed `healthDb`.
7. **No OTA compatibility gate.** `apps/mobile` has remote-config/push/links (VTID-05178) but no
   `min_native_version` manifest gate; incompatible bundles are not refused.
8. **Lineage guard + ORB health/commerce dispatcher rule not yet enforced for tenancy (D18, Apple 5.1.3).**
   The commerce-architecture ranking guard pattern (§7.2) is not applied to tenant-admin/analytics surfaces,
   and the ORB tool-dispatcher health/commerce separation is owned here only if `health-native` has not
   already shipped it (re-verify at slice start).

## Fix (per lane)
- **native-tenant-switch** (vitana-v1 `apps/mobile`): client `switchActiveTenant(slug)` → calls the DB RPC →
  `refreshSession()` → waits for the new claim before fetching tenant data; device-stored last tenant is only
  an INPUT, re-validated server-side on launch; in-app community picker + "join this community" screen;
  universal-link `/<slug>` routed through `apps/mobile/app/+native-intent.tsx` to the switch, never a silent
  Maxina default. No Maxina constants beyond the exempted store identifiers (D16).
- **switch-tenant-rpc-db** (platform DB): SECURITY DEFINER `switch_active_tenant(p_slug)` — derives caller from
  `auth.uid()`, validates `user_tenants` membership, sets the `active_tenant_id` preference, rejects non-members
  (→ join flow) and unknown/reserved slugs; `reserved_tenant_slugs` seeded from `screens.json` top-level routes;
  `provision_tenant` rejects a reserved slug; per-device `transport text CHECK (transport IN ('appilix','native'))`
  on `user_device_tokens` with a one-owner-per-device partial unique index (VTID-03481 invariant). Expand/contract,
  rollback migration, read-only pre/post checks.
- **push-tenant-fanout** (platform gateway): stop overwriting `tenant_id` on token upsert; fetch tokens by
  `user_id` only for delivery; derive per-tenant push copy + deep link from the notification row's `tenant_id`;
  honour the transport flag so exactly one transport serves a device. Dark behind `mt.native_push_tenant_fanout`.
- **health-home-tenant-db** (platform DB): `app_users.health_home_tenant_id uuid` (FK `tenants`), backfilled to
  each user's current primary membership, set-once (NOT changed on `is_primary` change); a BEFORE-INSERT trigger
  sets it at first health write for new users; health tables stay `user_id`-owned. Expand/contract, rollback,
  pre/post checks. Health table membership references `mt-identity`'s canonical `isHealthTable()` predicate
  (CROSS-SPEC O1) — this lane never defines its own list.
- **health-db-accessor** (platform gateway): `healthDb(userId)` resolves the frozen home tenant itself and is the
  only path to health tables; health tables EXCLUDED from `TENANT_TABLES`; convert the named session-tenant
  readers/writers in Problem #5 to `healthDb`; a generated inventory + lint routes every health reader/writer
  through it. Dark behind `mt.health_home_tenant`.
- **ota-compat-gate** (vitana-v1 `apps/mobile`): every OTA bundle manifest declares `min_native_version` (+ required
  plugin versions); the shell reports its version/plugins at startup and on device registration; the client refuses
  an incompatible bundle and stays on its last compatible one; native-dependent features gated by runtime capability
  detection, not bundle version.
- **lineage-guard-health** (platform, governance SQL/workflow — executor claude, CROSS-SPEC O1): build-failing guard
  test (modelled on commerce architecture §7.2) that no tenant-admin/tenant-owner analytics surface reads
  `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*` (D18); the ORB tool-dispatcher health/commerce rule
  (Apple 5.1.3) if `health-native` has not shipped it, enforced in the dispatcher (not the declared catalog), proven on
  Nova and the Vertex Serbian bridge.

## Migrations
Spec range `20261101130000`–`20261101135959`. Executor renumbers if a later migration exists at build time and adds
MIGRATION-QUEUE rows at the stated position (after the applied rows 1–8).
- `20261101130000_mt_native_health_switch_tenant_rpc.sql` — `switch_active_tenant`, `reserved_tenant_slugs`,
  `provision_tenant` reserved-slug guard, `user_device_tokens.transport` + one-owner index (switch-tenant-rpc-db).
  Rollback `docs/validation/<vtid>/rollback-switch-tenant.sql`.
- `20261101131000_mt_native_health_home_tenant.sql` — `app_users.health_home_tenant_id` + backfill + set-once trigger
  (health-home-tenant-db). Rollback `docs/validation/<vtid>/rollback-health-home.sql`.
MIGRATION-QUEUE position: appended after row 8, order switch-tenant-rpc-db → health-home-tenant-db; both depend on
`mt-identity` (membership unification, `isHealthTable()`) and A-M1 `tenants.is_default`/`is_platform`
(`20261014000100`). Each: `lock_timeout`, read-only `live-before.sql`/`post-apply-checks.sql`, pre-approved rollback,
applied by Claude via RUN-MIGRATION after merge; owner approves the apply.

## Tests
- pgTAP: `switch_active_tenant` rejects a non-member and a reserved slug; sets the preference for a member;
  `transport` one-owner invariant holds under re-registration; `health_home_tenant_id` is set-once and unchanged on
  `is_primary` change.
- Vitest/Jest (gateway): token upsert no longer writes `tenant_id`; delivery fetches by `user_id`; a dual member
  (`ab_dual`) receives pushes from both tenants with per-tenant copy (contract test); every health reader/writer goes
  through `healthDb`; health tables are not in `TENANT_TABLES` (inventory lint).
- Vitest (apps/mobile): switch waits for the matching claim before fetching; a tenant-B deep link for a tenant-A-only
  member lands on the join screen with no data fetched; OTA gate refuses an incompatible bundle (old-binary fixture).
- Build-failing lineage-guard test (lineage-guard-health); ORB tool-dispatch tests on Nova and the Vertex Serbian
  bridge for the health/commerce rule.
- Golden/regression required when touched: `npm run test:support` (42c), `npm run test:operator` (42e),
  `npm run test:roles` (42h) for ORB dispatcher; Maxina golden suite (push copy) unchanged.
- Native parity ledger updated (`node scripts/native/parity-ledger.mjs --sync`) for new app screens; nav
  registry/screen manifest when `App.tsx` routes are added (web side); 11 locales DE-first du-form + RTL.

## Staging verification
Read-only (rule 48): native checks run on the D11 local stack / fixture tenants and the `vitana-mobile-testing` skill;
the only production-facing native check is a read-only build/health GET. Gateway/DB changes verified on
`preview-aws-gateway.vitanaland.com` read-only; `ci_tenant_isolation_health()` reports zero. No writes, no sign-in
probes, no new community content. Each deploying lane adds its own read-only `docs/validation/<vtid>/staging-tests.json`.

## Rollout
Dark by default: gateway/frontend reads behind `tenant_settings.feature_flags.mt.native_push_tenant_fanout`,
`mt.health_home_tenant` and the master `MT_RESOLUTION_V2`. DB migrations applied by Claude via RUN-MIGRATION after merge
following the §4.7 DB-slice protocol; owner approves each apply and the auth-config step if any. Native store release and
the OTA channel promotion are owner-gated (D19) and out of this spec's merge path.

## Risks
- Dropping the `tenant_id` filter from push delivery could over-deliver if a token's historical `tenant_id` was
  load-bearing elsewhere — mitigated by fetching by `user_id` and deriving copy/deep-link from the notification row,
  with the `ab_dual` contract test. Expand/contract keeps the column until all readers move.
- `health_home_tenant_id` backfill on a live `app_users` must be batched/off-peak; set-once avoids churn on
  `is_primary` changes.
- Health re-keying to user-only (dropping `tenant_id` from health unique keys) is the Health plan's target and is NOT
  done here; this lane only freezes the home tenant and routes through `healthDb`.

## Out of scope
Native shell, screen ports, EAS/TestFlight/Play builds, Health Hub phases 0–5 (all `health-native`); health table
re-keying to user-only unique keys (Health plan); full tenant switching UI (M3, D8); custom domains / white-label apps
(M3); messenger/Discover/matching Network scope (mt-network, mt-discover); `supplier_tenant_relationships`
(mt-discover); `platform_only_accounts` view (mt-community-isolation M2); `isHealthTable()` predicate definition
(mt-identity — referenced only).

## Depends on
Specs: `mt-identity` (membership unification, `tenant_id_for_policies()`, `TENANT_TABLES`/`tenantDb`, canonical
`isHealthTable()` — CROSS-SPEC O1), `mt-guardrails` (isolation suite, DB lints, local stack). Done: A VTID-05149
(`tenants.is_default`/`is_platform`, migration `20261014000100`), B VTID-05150 (`provision_tenant`), C VTID-05151
(public tenant registry). Program: `health-native` (VTID-05020/05021) — this spec is its tenancy delta, not a
replacement.

## Owner decisions
Implements decided items: D4 native iOS+Android, D5 `vitanaland.com/<slug>` + reserved slugs, D8 one active tenant per
session + minimal server-side switch in N1, D16 platform-branded store identity (no Maxina constants beyond store ids),
D18 tenant operators get no health data, D19 OTA promoted by PUBLISH. No new decisions proposed.
<!-- plan:end -->

## Open questions for sparring
- Whether the ORB health/commerce dispatcher rule is already shipped by `health-native` (re-verify at slice start); if
  so, `lineage-guard-health` drops that half and keeps only the D18 analytics guard.
