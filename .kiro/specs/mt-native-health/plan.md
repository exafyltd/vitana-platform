---
change_class: standard
---
# mt-native-health — multi-tenancy contract for the native app and health data

<!-- plan:begin -->
## Problem
WS9 **native tenancy delta** + WS10 **health×tenancy contract** (`docs/MULTI-TENANT-PLAN.md` §8, §9). Owns the
tenancy rules only; the native app and health pipeline are `health-native` (VTID-05021, VTID-05020). Premises
verified on platform origin/main:

1. **Health identity is keyed by tenant, written from the session's active tenant** (program §9). The daily
   health upsert conflict target is `tenant_id,user_id,date,feature_key` (`integrations-repository.ts:85`,
   `diary-health-extractor-repository.ts:24`); the tenant comes from a `limit(1).maybeSingle()` session fallback
   (`integrations-repository.ts:67-68`, `routes/health-repository.ts:68-69`); readers take the session `tenantId`
   (`automation-handlers/health-wellness-repository.ts:44,50`, `health-action-initiative-repository.ts:54,60`,
   reading `vitana_index_scores`/`wearable_workouts`). So a member who switches active tenant writes/reads a
   different health series — a dual member silently splits their own data. No `health_home_tenant_id` exists today.

2. **No guard stops tenant-analytics or commerce surfaces reading health data** (program §9, D18). Nothing fails
   the build if a tenant-admin KPI, tenant-owner analytics or a Discover/commerce reader joins
   `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*`. S-L (the live tenant-admin partner-health leak)
   is owned by mt-tenant-admin; this spec adds the standing build-failing guard so a regression cannot reintroduce
   it. (`isHealthTable()` is mt-identity's, CROSS-SPEC O1; this spec imports it, never keeps its own list.)

3. **Native push drops a dual member's second-tenant pushes** (program §8). `/token`
   (`services/gateway/src/routes/notifications.ts:62-117`) upserts `tenant_id: identity.tenant_id` on every
   registration (`:107-110`) and `user_device_tokens_one_active_owner` keeps one active row per (user, token). The
   delivery filter is `fetchLiveDeviceTokensForUser(sb, userId, tenantId)` at
   `services/gateway/src/services/notification-service-repository.ts:28`, which filters tokens by both
   `.eq('user_id', userId)` (`:40`) and `.eq('tenant_id', tenantId)` (`:41`) and is SHARED by the legacy and
   native push paths (`notification-service.ts:410-411`, `push-routing.ts:177`), so a dual member's other-tenant
   device is never returned. VTID-05177 added `NATIVE_PUSH_DIRECT_ENABLED` (`notifications.ts:25,77`) but not this.

4. **The native app's tenant resolution contract is unverified against the program invariant** (program §8, N1).
   `apps/mobile/` (vitana-v1) is a built Expo/React Native app (not the Capacitor shell the program assumed;
   drift corrected here) with a tenant layer (`src/identity/TenantProvider.tsx`, `tenant-registry.ts`,
   `useMemberships.ts`), deep-link routing (`src/linking/resolve-link.ts`, `app/+native-intent.tsx`) and
   tenant/deep-link Maestro flows (`maestro/shell/08-tenants.yaml`, `10-deep-link-admin.yaml`). The N1 invariant —
   the JWT claim is the ONLY in-app resolution source; a deep link to a non-member tenant lands on "join" with no
   tenant data fetched — has no contract test pinning it. vitana-v1 pin: `origin/main` baseline `e45fee2f`, listing
   in `docs/validation/<VTID>/vitana-v1-premises.md`. Tests only; a missing file → log + `next_actor: claude`.

## Fix (per lane)
- **health-home-tenant-db** (vitana-platform, DB). Add `app_users.health_home_tenant_id uuid` (nullable; FK to
  `tenants(id)`), a `health_home_tenant_id(p_user uuid)` STABLE SECURITY DEFINER resolver returning the frozen home
  tenant (backfilled to the user's current primary `user_tenants` row; set at first health write for new users), and
  a batched backfill of existing `app_users`. Expand/contract only: nullable column → backfill → the accessor reads
  it with a primary-membership fallback when NULL. No read path changes here. Migrations register in
  `docs/multitenancy/MIGRATION-QUEUE.md` after the mt-identity membership-unification rows (health home freeze needs
  canonical `user_tenants.is_primary`).
- **health-tenant-accessor** (vitana-platform, gateway). Add `healthDb(userId)`: a user-keyed accessor that
  resolves the frozen home tenant via `health_home_tenant_id()` and injects it, so no health reader/writer takes a
  session tenant. Convert the five verified sites (`integrations-repository.ts`,
  `diary-health-extractor-repository.ts`, `health-wellness-repository.ts`, `health-action-initiative-repository.ts`,
  `health-repository.ts`). **Generate the inventory FIRST** and classify each entry: (a) convert-to-`healthDb` (`health_features_daily`,
  `vitana_index_scores`, `biomarker_results`, `wearable_workouts`, written/read with a session tenant); (b) already
  user-keyed, no injection (`wearables-repository.ts:72` `wearable_rollup_7d`, `:77` `wearable_daily_metrics`); (c)
  service-role job. **R2-F1:** `fetchVitanaIndexScoreForDate` (`health-repository.ts:51`, date-only `.single()`, sole
  caller GET /summary `health.ts:529`, user-JWT client) is (a) WITH a signature change: `(sb, userId, date)` filtering
  `user_id` (+ home tenant via `healthDb`), userId from `auth.getUser()` as at `health.ts:643-647`. **The lint
  ships warning-only, build-failing in the SAME PR that clears every (a).** **Writers
  and readers convert together (R1-F4):** the two writers (`upsertHealthFeatureDaily`, `integrations-repository.ts:72`,
  `diary-health-extractor-repository.ts:23`) and the readers switch in ONE PR behind ONE flag, `MT_RESOLUTION_V2`, so
  write and read tenant come from one resolver. Flag off = today's `limit(1)` path. The conflict target includes
  `tenant_id` (`:85`, `:24`), so the flip is a real change for dual members (see Risks). depends_on:
  health-home-tenant-db.
- **health-analytics-lineage-guard** (vitana-platform, gateway). A build-failing guard test (modelled on the
  commerce §7.2 ranking guard) asserting that every module in the generated **tenant-analytics + commerce reader**
  inventory (tenant-admin overview/KPIs/health-index, tenant-owner analytics, exports, Discover feed/search, ORB
  product/cart tools, autopilot offers) reads no `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*`.
  **Forbidden set = mt-identity's predicate (R1-F3, CROSS-SPEC O1):** the guard imports `isHealthTable` from
  `services/gateway/src/services/tenancy/is-health-table.ts` (lane mt-identity/tenant-db-and-slug-cleanup) — no local
  list. Cross-spec dependency, stated: this lane is HELD until that file is on main. The generated reader inventory is
  committed as the fixture `services/gateway/test/mt-native-health/health-lineage-inventory.json`; the test regenerates
  it and fails on drift, and filters its table names through `isHealthTable()`, so the inventory and the predicate
  cannot silently diverge. Warning-only until health-tenant-accessor's (a) conversions merge, then build-failing. Member-coaching modules
  (community-autopilot scan, news feed, morning brief, health-wellness/health-action automations) are OUTSIDE the
  guard. pgTAP: a T_B tenant admin reads zero health rows. depends_on: health-tenant-accessor.
- **native-push-tenant** (vitana-platform, gateway). Add a NEW variant
  `fetchLiveDeviceTokensForUserAcrossTenants(sb, userId, opts?)` in `notification-service-repository.ts`, identical
  to `fetchLiveDeviceTokensForUser` (`:28`) but WITHOUT the `.eq('tenant_id', tenantId)` filter (`:41`); the
  existing function stays UNCHANGED (shared with legacy). The native pass (`push-routing.ts:177`) uses the new
  variant only when `MT_RESOLUTION_V2` is on. The one-owner transport invariant (`appilix` | `native`, VTID-03481/05177) is preserved. Dark behind
  `NATIVE_PUSH_DIRECT_ENABLED` (native) + `MT_RESOLUTION_V2` (across-tenant fetch). **One notification = one
  tenant (R1-F1):** `notifyUser(userId, tenantId, type, payload)` (`notification-service.ts:809`) is called once per
  notification and passes that ONE payload to `dispatchPush` (`:951`); this lane does not re-derive copy per tenant.
  The new variant only widens WHICH devices a given notification reaches. Contract test: ab_dual has ONE native device
  whose token row carries T_A; `notifyUser(…, T_B, …)` reaches it with T_B's caller-built payload unchanged (today it
  reaches nothing), and `notifyUser(…, T_A, …)` still reaches it with T_A's. Per-tenant copy for one notification is
  out of scope. The fetch happens inside `sendPushToUser` (`notification-service.ts:410-411`), so that file gains an
  `acrossTenants` opt the native pass sets. Independent lane (no health-home dependency).
- **native-tenant-isolation-tests** (vitana-v1, `apps/mobile`). Contract/Jest tests on the EXISTING app (no shell
  build): (a) the resolved tenant comes only from the JWT claim path, never from `device-storage`/deep-link slug
  alone (`src/identity/TenantProvider.tsx`, `src/linking/resolve-link.ts`); (b) a deep link to a tenant the signed-in
  member does not belong to resolves to the "join this community" screen and fetches no tenant data; (c) the push
  registration (`src/push/registration.ts`) sends only `user_id`-scoped identity, carrying no client-chosen tenant.
  Uses the existing fake-gateway/fixture harness (`tests/helpers/`), fixture tenants T_A/T_B. No production calls.

## Migrations
Spec range `20261101130000`–`20261101135959` (NN=13; the executor renumbers if a later migration exists at
implementation time and inserts the MIGRATION-QUEUE rows at the stated position). Only **health-home-tenant-db**
adds migrations:
- `20261101130000_vtid_xxxxx_app_users_health_home_tenant.sql` — add nullable `health_home_tenant_id` + FK + index.
- `20261101130100_vtid_xxxxx_health_home_tenant_resolver.sql` — `health_home_tenant_id(uuid)` resolver + backfill
  of existing `app_users` (batched, `lock_timeout`, off-peak), snapshot `bak_*` table retained 30 days.
- **Self-enforcing ordering (F6, no hard mt-identity block):** the backfill opens with a guard that `RAISE
  EXCEPTION` unless every member has exactly one primary `user_tenants` row (`count(... is_primary) <> 1`), so it
  refuses to run until `is_primary` is canonical (by mt-identity or otherwise). The "after mt-identity" queue
  position is thus a preference, not a blocker — if mt-identity is delayed the migration aborts rather than freezing
  wrong tenants (MIGRATION-QUEUE has 8 applied rows, none membership-unification).
- Rollback: `docs/validation/<VTID>/rollback.sql` (drop resolver, restore from snapshot, drop column), owner-applied.
  Read-only pre-check: count ambiguous members (0 or 2+ primary → quarantine, never Maxina). Post-check: every
  `app_users` row has a `health_home_tenant_id` or is quarantined; the resolver returns one tenant for a dual member
  in either session. Applied by Claude via RUN-MIGRATION after merge (Kiro never applies).
- `docs/MULTI-TENANT-PLAN.md` is hash-locked and is NOT edited by any lane; the Capacitor→Expo drift is recorded
  in this spec only.

## Tests
- Vitest/Jest (gateway): `healthDb` resolves the frozen home tenant for a dual member regardless of session; the
  five converted repos call it, not the session fallback; the inventory lint fails on a planted session-tenant read.
- pgTAP: `health_home_tenant_id()` stable across sessions for ab_dual; T_B tenant admin reads zero health rows;
  backfill idempotent.
- Guard: planting a `health_*` read in a tenant-analytics/commerce module fails the build; a member-coaching read
  is allowed. Contract: ab_dual push from both tenants; native app resolves tenant only from the claim and a
  non-member deep link fetches nothing.
- Standing suites: `npm run test:support` (42c), `npm run test:operator` (42e) when the touched gateway code
  intersects them; 42h not touched. Parity ledger updated only if a route is added (none — tests only).

## Staging verification (read-only, rule 48)
Gateway: STAGING-VERIFY smoke + `docs/validation/<VTID>/staging-tests.json` (read-only RPC/health GETs confirming the
resolver exists and returns a value for a known dual member; no writes). Native: Jest/contract in CI; a read-only
Maestro flow confirms a non-member deep link lands on "join" on `preview-aws`. No suite targets production; the
backfill is verified by the read-only post-check SQL Claude runs after apply.

## Rollout
Dark by default. Gateway health read+write changes gate on `MT_RESOLUTION_V2` (flip only after the backfill
post-check passes); native direct push gates on
`NATIVE_PUSH_DIRECT_ENABLED` (existing). The DB column + resolver are additive and inert until the accessor reads
them. Order: health-home-tenant-db (DB, owner-applied) → health-tenant-accessor → health-analytics-lineage-guard.
native-push-tenant and native-tenant-isolation-tests are INDEPENDENT and may run any time (no dependency on
health-home-tenant-db). Owner-only steps: applying the two migrations (RUN-MIGRATION) and the production PUBLISH at
Gate 2.

## Risks
- Freezing the home tenant for members with 0 or 2+ primary memberships is ambiguous → the backfill `RAISE
  EXCEPTION` guard refuses to run until `is_primary` is canonical, so the ambiguous case cannot be mis-frozen; those
  members are quarantined, never defaulted to Maxina.
- Flag flip changes rows for dual members (R1-F2/F4): off-state resolves `user_tenants … limit(1).maybeSingle()`
  (`integrations-repository.ts:67-68`, `health-repository.ts:68-69`), an arbitrary row; on-state resolves the frozen
  home tenant. For a dual member these can differ, so a flip moves reads AND writes to the home series and leaves any
  rows written under another tenant unread (never deleted). Mitigation: flag off keeps today's path; the flip is
  gated on the backfill post-check passing; a read-only pre-flip count of dual members with health rows outside
  their home tenant goes in `docs/validation/<VTID>/`; merging those rows is Health Hub's re-key (out of scope).
- The lineage guard inventory is generated; a new tenant-analytics reader not yet in the inventory could slip through
  → the test regenerates the inventory each build and fails on drift from the committed fixture.

## Out of scope
- Building the native app shell or any screen port (health-native, Native app VTID-05021).
- The health-data pipeline itself: connectors, consent store, sync, labs, AI recommendations (health-native, Health
  Hub VTID-05020).
- `isHealthTable()`, the access-token hook, `tenant_id_for_policies()`, membership unification, TenantContext
  (mt-identity).
- Removing the live S-L tenant-admin partner-health scope (mt-tenant-admin); re-keying health unique keys to drop
  `tenant_id` (Health Hub target state) — this spec only freezes the home tenant for reads/writes as they stand.
- Commerce distribution scope / `supplier_tenant_relationships` (mt-commerce).

## Depends on
- Specs: mt-identity (`isHealthTable()` in `services/tenancy/is-health-table.ts`, lane tenant-db-and-slug-cleanup —
  HARD for health-analytics-lineage-guard only, per O1; membership unification — SOFT: the backfill `RAISE EXCEPTION`
  guard self-enforces; TenantContext, resolver); mt-tenant-admin (S-L); health-native (native app + health pipeline
  this contract wraps). The other four lanes do not wait on mt-identity.
- Lanes (within this spec): health-tenant-accessor → health-home-tenant-db; health-analytics-lineage-guard →
  health-tenant-accessor. native-push-tenant and native-tenant-isolation-tests are independent (no in-spec deps).
- Done VTIDs built on: VTID-05177 (native token fields + `NATIVE_PUSH_DIRECT_ENABLED`), VTID-05149 (`tenants.is_default`).

## Owner decisions
Cited (DECIDED): D4 native iOS+Android, D8 one active tenant per session + health owned by user, D18 no tenant-op
health access, D19 native delivery, D22 in-app payments (untouched). **D17 reconciled to reality: the app is
Expo/React Native (`apps/mobile/`), already built — not the Capacitor shell §6 WS9 still describes.** A factual
correction, not a reversal (D4 stands), recorded here; the hash-locked program doc is not amended. No new owner
decision proposed.
<!-- plan:end -->

## Open questions for sparring
- The MIGRATION-QUEUE insertion point for health-home-tenant-db is stated as "after mt-identity's membership
  rows", which are not yet numbered on origin; the backfill `RAISE EXCEPTION` guard makes this safe regardless of
  timing, and the executor fixes the exact row once mt-identity's numbers land. (Was a blocker; now self-enforced.)
- Whether the frozen `health_home_tenant_id` should be re-keyed out entirely when Health Hub's user-keyed
  `health_observations` lands (program §9 target state) is tracked by health-native, not re-opened here.
