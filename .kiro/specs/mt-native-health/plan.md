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
2. **The server-side active-tenant switch already exists; the gaps are an in-app picker/join and `/<slug>`
   routing, not the RPC.** `public.switch_to_tenant_by_slug(p_tenant_slug text)` is live and hardened
   (`20261010180200_vtid_05043_…:38-125`): SECURITY DEFINER, caller from `auth.uid()`, validates `user_tenants`
   membership, joins only `open_signup` tenants else raises `TENANT_NOT_JOINABLE` (42501), raises on unknown slug,
   sets `raw_app_meta_data->'active_tenant_id'`. The native app ALREADY does the client half:
   `apps/mobile/src/identity/TenantProvider.tsx:115` calls it, maps 42501 → `not_joinable`, `:122-126`
   `refreshSession()` → reads the new claim → `setActiveTenantId` → stores the slug. MISSING: an in-app community
   picker + "join this community" screen, and `/<slug>` universal-link routing through
   `apps/mobile/app/+native-intent.tsx` (no silent Maxina default). NO new `switch_active_tenant` RPC — reuse the
   existing one.
3. **Reserved slugs are ALREADY shipped and applied (VTID-05150), not a gap.** `public.reserved_tenant_slugs`
   created + seeded (`20261014000400_…:129-170`), `provision_tenant` raises `RESERVED_SLUG` (`20261014000500_…:124`),
   `services/gateway/src/services/tenant-provisioning/reserved-slugs.ts` pre-checks, and `gen-reserved-slugs.mjs` +
   `TENANT-RESERVED-SLUGS-DRIFT.yml` sync it from `screens.json` (MIGRATION-QUEUE rows 5–6 applied 2026-10-13;
   VTID-05150 is this spec's DONE dependency). This spec does NOT re-create or re-plan any of it. The only genuinely
   missing DB change in this area is the per-device transport one-owner flag (Problem #4).
4. **No per-device transport one-owner flag.** `user_device_tokens` has `device_type`
   (`ios_native|android_native`, VTID-05177) but no `appilix|native` transport flag with a one-owner
   invariant per device (the Appilix→native cutover guarantee). `user_device_tokens_one_active_owner`
   (one active row per token) exists already (`routes/notifications.ts:95-97`).
5. **Health identity is keyed by session tenant, not a frozen home tenant.** `app_users` has no
   `health_home_tenant_id` column (grep: 0 hits). Health readers/writers use the session tenant today
   (§4.9: `integrations-repository.ts:84`, `diary-health-extractor-repository.ts:24`, `health-repository.ts:52`,
   `health-wellness-repository.ts:44,50`, `health-action-initiative-repository.ts:54`). A dual member in a tenant-B
   session reads/writes a different series than in tenant A — `health_features_daily UNIQUE (tenant_id, user_id, …)`
   keys on tenant.
6. **No `healthDb(userId)` accessor and no `TENANT_TABLES` exclusion for health.** Neither `healthDb` nor
   `TENANT_TABLES` exists yet (grep: 0 hits) — `tenantDb`/`TENANT_TABLES` are introduced by `mt-identity`.
   Health tables must be EXCLUDED from `TENANT_TABLES` and reached only through a user-keyed `healthDb`.
7. **No OTA compatibility gate.** `apps/mobile` has remote-config/push/links (VTID-05178) but no
   `min_native_version` manifest gate; incompatible bundles are not refused.
8. **Lineage guard + ORB health/commerce dispatcher rule not yet enforced for tenancy (D18, Apple 5.1.3).**
   The commerce §7.2 guard pattern is not applied to the tenant-admin analytics surface
   (`services/gateway/src/routes/tenant-admin/*-repository.ts`), and the ORB dispatcher health/commerce
   separation is owned here only if `health-native` has not shipped it (re-verify at slice start).

## Fix (per lane)
- **native-tenant-switch** (vitana-v1 `apps/mobile`): the client switch (RPC call, `refreshSession()`, claim-gate,
  stored-slug re-validation) already exists in `TenantProvider.tsx:112-126`; this lane adds ONLY the delta — an
  in-app community picker screen (`list_public_tenants`), a "join this community" screen reached on the
  `not_joinable` return, and `/<slug>` universal-link routing through `apps/mobile/app/+native-intent.tsx` to the
  existing `switchActiveTenant`/`switch_to_tenant_by_slug` path (never a silent Maxina default). It gates
  tenant-data queries on the claim already set by `TenantProvider`. No Maxina constants beyond the exempted store
  identifiers (D16).
- **switch-tenant-rpc-db** (platform DB): the switch RPC (`switch_to_tenant_by_slug`, `20261010180200`) and reserved
  slugs (VTID-05150) already exist — this lane creates NEITHER. Its sole genuine DB delta is the per-device transport
  one-owner flag: `user_device_tokens.transport text CHECK (transport IN ('appilix','native'))` + a
  one-owner-per-device partial unique index (VTID-03481). IF a real switch-RPC gap is confirmed at build time (none
  is known — `TenantProvider.tsx:116` already maps 42501 → `not_joinable`), extend `switch_to_tenant_by_slug` in
  place, keeping its `GRANT EXECUTE … TO authenticated` / `REVOKE … FROM PUBLIC, anon` grants (`20261010180200:126-127`),
  never a parallel RPC. Expand/contract, rollback migration, read-only pre/post checks.
- **push-tenant-fanout** (platform gateway): stop overwriting `tenant_id` on token upsert; fetch tokens by
  `user_id` only for delivery; derive per-tenant push copy + deep link from the notification row's `tenant_id`;
  honour the transport flag so exactly one transport serves a device. Dark behind `mt.native_push_tenant_fanout`.
- **health-home-tenant-db** (platform DB): `app_users.health_home_tenant_id uuid` (FK `tenants`), backfilled
  set-once (NOT changed on `is_primary` change) by a deterministic rule: the user's `is_primary=true`
  `user_tenants` row; when none/ambiguous, the `is_default`/`is_platform` tenant the user is a member of, else the
  oldest `user_tenants` row by `created_at` — the same tie-break `20261014000200_vtid_05149_signup_default_tenant.sql`
  uses, so the pgTAP "backfill matches current primary" assertion is well-defined for every row. A BEFORE-INSERT
  trigger sets it at first health write for new users; health tables stay `user_id`-owned. Expand/contract,
  rollback, pre/post checks. Health table membership references `mt-identity`'s canonical `isHealthTable()`
  predicate (CROSS-SPEC O1) — this lane never defines its own list.
- **health-db-accessor** (platform gateway): `healthDb(userId)` (new, `services/gateway/src/services/health-db.ts` —
  no `services/health/` dir) resolves the frozen home tenant itself and is the only path to health tables; health
  tables EXCLUDED from `TENANT_TABLES`; convert the Problem #5 readers/writers at their REAL paths (re-verified at
  build time); a generated inventory + lint fails on any bypass. States whether `healthDb` subsumes the ORB resolver
  `resolveHealthTenantId()` (`services/orb-tools/health-depth-tools.ts:118`) — the frozen-home-tenant rule is
  authoritative. Dark behind `mt.health_home_tenant`.
- **ota-compat-gate** (vitana-v1 `apps/mobile`): every OTA bundle manifest declares `min_native_version` (+ required
  plugin versions); the shell reports its version/plugins at startup and on device registration; the client refuses
  an incompatible bundle and stays on its last compatible one; native-dependent features gated by runtime capability
  detection, not bundle version.
- **lineage-guard-health** (platform, governance — executor claude, CROSS-SPEC O1): build-failing guard, **per-query
  not per-module** (the mt-discover resolution), scanning the concrete surface set
  `services/gateway/src/routes/tenant-admin/*-repository.ts` (overview, kpis, insights, product-analytics,
  community-admin, audit-log, health-index) + their routes — fails a `.from()` read of a per-member health table
  `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*` there (D18). It does NOT fail a tenant-level
  aggregate (`health-index-repository.ts` → `tenant_health_index_daily`) or a member-facing `healthDb` reader
  (Problem #5 files), which are outside the set. `isHealthTable()` defines membership (O1). Plus the ORB
  dispatcher health/commerce rule (Apple 5.1.3) if `health-native` has not shipped it — enforced in the dispatcher,
  proven on Nova and the Vertex Serbian bridge.

## Migrations
Spec range `20261101130000`–`20261101135959`. Executor renumbers if a later migration exists at build time and adds
MIGRATION-QUEUE rows at the stated position (after the applied rows 1–8).
- `20261101130000_mt_native_health_transport_flag.sql` — `user_device_tokens.transport` + one-owner partial unique
  index (switch-tenant-rpc-db); plus, only if a real switch-RPC gap is confirmed at build time, an in-place
  `CREATE OR REPLACE` of `switch_to_tenant_by_slug` (never a new RPC). Does NOT touch `reserved_tenant_slugs` or
  `provision_tenant` (already shipped by VTID-05150). Rollback `docs/validation/<vtid>/rollback-transport-flag.sql`.
- `20261101131000_mt_native_health_home_tenant.sql` — `app_users.health_home_tenant_id` + backfill + set-once trigger
  (health-home-tenant-db). Rollback `docs/validation/<vtid>/rollback-health-home.sql`.
MIGRATION-QUEUE position: appended after row 8, order switch-tenant-rpc-db → health-home-tenant-db; both depend on
`mt-identity` (membership unification, `isHealthTable()`) and A-M1 `tenants.is_default`/`is_platform`
(`20261014000100`). Each: `lock_timeout`, read-only `live-before.sql`/`post-apply-checks.sql`, pre-approved rollback,
applied by Claude via RUN-MIGRATION after merge; owner approves the apply.

## Tests
- pgTAP: the `transport` one-owner invariant holds under re-registration (one active transport per device);
  `health_home_tenant_id` is set-once and unchanged on `is_primary` change, and the backfill tie-break resolves one
  row per user. (`switch_to_tenant_by_slug`'s own member/non-member/unknown-slug behaviour is already covered by its
  VTID-05043 tests; this spec re-tests only an in-place extension if one is actually made.)
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
re-keying to user-only unique keys (Health plan); full tenant switching UI + custom domains (M3, D8); Network scope
(mt-network); `supplier_tenant_relationships` (mt-discover); `platform_only_accounts` (mt-community-isolation M2);
`isHealthTable()` definition (mt-identity); and all work reused-not-rebuilt: the `switch_to_tenant_by_slug` RPC
(VTID-05043) and reserved slugs / `provision_tenant` guard / screens.json drift sync (VTID-05150, applied).

## Depends on
Specs: `mt-identity` (membership unification, `TENANT_TABLES`/`tenantDb`, canonical `isHealthTable()` — O1),
`mt-guardrails` (isolation suite, DB lints, local stack). Done (reused, not rebuilt): A VTID-05149
(`tenants.is_default`/`is_platform`, `20261014000100`), B VTID-05150 (reserved slugs + guard + drift sync,
`20261014000400`/`20261014000500`), C VTID-05151 (`list_public_tenants`), S3 VTID-05043 (`switch_to_tenant_by_slug`,
`20261010180200`). Program: `health-native` (VTID-05020/05021) — this spec is its tenancy delta, not a replacement.

## Owner decisions
Implements: D4 native iOS+Android; D5 `vitanaland.com/<slug>` (reserved slugs shipped by VTID-05150); D8 one active
tenant per session + the N1 server-side switch; D16 platform-branded store identity (no Maxina constants beyond store
ids); D18 tenant operators get no health data; D19 OTA promoted by PUBLISH. No new decisions proposed.
<!-- plan:end -->

## Open questions for sparring
- Whether the ORB health/commerce dispatcher rule is already shipped by `health-native` (re-verify at slice start); if
  so, `lineage-guard-health` drops that half and keeps only the D18 analytics guard.
