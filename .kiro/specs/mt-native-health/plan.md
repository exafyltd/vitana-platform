---
change_class: standard
---
# mt-native-health — multi-tenancy contract for the native app and health data

<!-- plan:begin -->
## Problem
This spec is the WS9 **native tenancy delta** and the WS10 **health×tenancy contract** of the multi-tenant
program (`docs/MULTI-TENANT-PLAN.md` §8, §9, WS9, WS10). It owns the tenancy rules the native app and the
health-data pipeline must obey; it does NOT build the native app or the health pipeline (that is the
`health-native` spec: Native app VTID-05021, Health Hub VTID-05020). Premises re-verified against code at the
branch tip on 2026-10-15:

1. **Health identity is keyed by tenant, written from the session's active tenant** (program §9). The daily
   health upsert conflict target is `tenant_id,user_id,date,feature_key` at
   `services/gateway/src/routes/integrations-repository.ts:85` and
   `services/gateway/src/services/diary-health-extractor-repository.ts:24`; the tenant is resolved from a
   `limit(1).maybeSingle()` session fallback (`integrations-repository.ts:67-68`,
   `services/gateway/src/routes/health-repository.ts:68-69`). Readers take the session `tenantId`
   (`services/gateway/src/services/automation-handlers/health-wellness-repository.ts:44,50` reading
   `vitana_index_scores`; `.../health-action-initiative-repository.ts:54,60` reading `vitana_index_scores` and
   `wearable_workouts`). A member who switches active tenant therefore writes/reads a different health series —
   a dual member silently splits their own data. There is no `health_home_tenant_id`, no `healthDb` accessor and
   no `TENANT_TABLES` list today (verified: zero matches in gateway/migrations).

2. **No guard stops tenant-analytics or commerce surfaces reading health data** (program §9 lineage guard, D18).
   `isHealthTable()` does not exist yet (it is owned by mt-identity, CROSS-SPEC O1). Nothing fails the build if a
   tenant-admin KPI, tenant-owner analytics or a Discover/commerce reader joins `health_*`/`wearable_*`/
   `biomarker_*`/`lab_*`/`vitana_index_*`. S-L (the live tenant-admin partner-health leak) is owned by
   mt-tenant-admin; this spec adds the standing build-failing guard so a regression cannot reintroduce it.

3. **Native push drops a dual member's second-tenant pushes** (program §8). `/token`
   (`services/gateway/src/routes/notifications.ts:62-117`) upserts `tenant_id: identity.tenant_id` on every
   registration (`:107-110`) and `user_device_tokens_one_active_owner` keeps one active row per (user, token), so
   a device's stored tenant is overwritten to the last-active tenant; delivery that filters tokens by tenant then
   loses the other tenant's pushes. VTID-05177 already added the native token fields and
   `NATIVE_PUSH_DIRECT_ENABLED` (`notifications.ts:32,71-78`) but did not fix the per-tenant delivery contract.

4. **The native app's tenant resolution contract is unverified against the program invariant** (program §8, N1).
   `apps/mobile/` (vitana-v1) is a built Expo/React Native app (NOT the Capacitor shell the program plan assumed;
   drift corrected here) with a tenant layer already present (`src/identity/TenantProvider.tsx`,
   `tenant-registry.ts`, `useMemberships.ts`), deep-link routing (`src/linking/resolve-link.ts`,
   `app/+native-intent.tsx`) and tenant/deep-link Maestro flows (`maestro/shell/08-tenants.yaml`,
   `10-deep-link-admin.yaml`). The N1 invariant — the JWT claim is the ONLY resolution source in-app, a deep link
   to a non-member tenant lands on "join" with no tenant data fetched — has no contract test pinning it.

## Fix (per lane)
- **health-home-tenant-db** (vitana-platform, DB). Add `app_users.health_home_tenant_id uuid` (nullable; FK to
  `tenants(id)`), a `health_home_tenant_id(p_user uuid)` STABLE SECURITY DEFINER resolver returning the frozen home
  tenant (backfilled to the user's current primary `user_tenants` row; set at first health write for new users), and
  a batched backfill of existing `app_users`. Expand/contract only: nullable column → backfill → the accessor reads
  it with a primary-membership fallback when NULL. No read path changes here. Migrations register in
  `docs/multitenancy/MIGRATION-QUEUE.md` after the mt-identity membership-unification rows (health home freeze needs
  canonical `user_tenants.is_primary`).
- **health-tenant-accessor** (vitana-platform, gateway). Add `healthDb(userId)` in the gateway data layer: a
  user-keyed accessor that resolves the frozen home tenant via `health_home_tenant_id()` itself and injects it, so no
  health reader/writer takes a session tenant. Convert the four verified sites (writers
  `integrations-repository.ts`, `diary-health-extractor-repository.ts`; readers
  `health-wellness-repository.ts`, `health-action-initiative-repository.ts`) plus `health-repository.ts` to route
  through it. Add a GENERATED inventory of every health reader/writer (grep of `.from('<health table>')` across
  `services/gateway/src`) and a build-failing lint that every entry goes through `healthDb` (allowlist for the
  accessor itself and service-role platform jobs). Dark behind `MT_RESOLUTION_V2` where a runtime read path changes;
  the accessor falls back to today's behaviour when the flag is off. depends_on: health-home-tenant-db.
- **health-analytics-lineage-guard** (vitana-platform, gateway). A build-failing guard test (modelled on the
  commerce architecture §7.2 ranking guard) asserting that every module in the generated **tenant-analytics +
  commerce reader** inventory (tenant-admin overview/KPIs/health-index, tenant-owner analytics, exports, Discover
  feed/search, ORB product/cart tools, autopilot offers) does not read `health_*`/`wearable_*`/`biomarker_*`/
  `lab_*`/`vitana_index_*`. The forbidden-table set is `isHealthTable()` from mt-identity (referenced, never
  re-listed — CROSS-SPEC O1). Member-facing health-coaching modules (community-autopilot scan, news feed, morning
  brief, health-wellness/health-action automations) are explicitly OUTSIDE the guard. pgTAP companion: a T_B tenant
  admin reads zero rows of each health table. depends_on: health-tenant-accessor.
- **native-push-tenant** (vitana-platform, gateway). Rewrite device-token fetch to key by `user_id` only (drop the
  tenant filter on fetch); derive each push's tenant copy and deep link from the NOTIFICATION row's `tenant_id`, not
  the token's; keep the transport one-owner invariant (`appilix` | `native` per device, VTID-03481/05177). Dark
  behind `NATIVE_PUSH_DIRECT_ENABLED` (already exists) for the native transport and `MT_RESOLUTION_V2` for the
  per-tenant delivery read path. Contract test: ab_dual (member of T_A and T_B) receives a push from each tenant
  with that tenant's copy and deep link, from one registered device. depends_on: health-home-tenant-db (shares the
  resolved-tenant helpers; no health coupling otherwise).
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
- Rollback: `docs/validation/<VTID>/rollback.sql` (drop resolver, restore from snapshot, drop column) — pre-approved,
  owner-applied. MIGRATION-QUEUE position: AFTER mt-identity's membership-unification rows, BEFORE any spec that
  reads the frozen home tenant. Read-only pre-check: count `app_users` with 0 or 2+ primary memberships (freeze is
  ambiguous for them → quarantine, never default to Maxina). Read-only post-check: every `app_users` row has a
  `health_home_tenant_id` or is in quarantine; the resolver returns the same tenant for a dual member in either
  session. DB applied by Claude via RUN-MIGRATION after merge (Kiro never applies).

## Tests
- Vitest/Jest (gateway): `healthDb` resolves the frozen home tenant for a dual member regardless of session tenant;
  the four converted repos call `healthDb`, not the session fallback; the reader/writer inventory lint fails on a
  planted session-tenant health read.
- pgTAP: `health_home_tenant_id()` is stable across sessions for ab_dual; a T_B tenant admin reads zero rows of each
  health table; the backfill is idempotent.
- Guard test (health-analytics-lineage-guard): planting a `health_*` read in a tenant-analytics/commerce module
  fails the build; a member-coaching module reading health is allowed.
- Contract: ab_dual push from both tenants (native-push-tenant); native app resolves tenant only from the claim and a
  non-member deep link fetches nothing (native-tenant-isolation-tests).
- Required standing suites per touched area: `npm run test:support` (42c) and `npm run test:operator` (42e) when the
  touched gateway code intersects those pipelines; `npm run test:roles` (42h) is not touched here. Native parity
  ledger (`apps/mobile/parity/ledger.json`) updated if any `App.tsx`/screen route is added (none expected — tests
  only).

## Staging verification (read-only, rule 48)
Gateway: STAGING-VERIFY smoke suite + this change's `docs/validation/<VTID>/staging-tests.json` (read-only RPC/health
GETs confirming the resolver exists and returns a value for a known dual member; no writes). Native: Jest/contract
suites run in CI; a Maestro read-only flow confirms a non-member deep link lands on "join" on `preview-aws`. No suite
targets production. The health-home backfill is verified by the read-only post-check SQL run by Claude after apply.

## Rollout
Dark by default. Gateway read-path changes gate on `MT_RESOLUTION_V2`; native direct push gates on
`NATIVE_PUSH_DIRECT_ENABLED` (existing). The DB column + resolver are additive and inert until the accessor reads
them. Order: health-home-tenant-db (DB, owner-applied) → health-tenant-accessor → health-analytics-lineage-guard;
native-push-tenant and native-tenant-isolation-tests run in parallel after health-home-tenant-db. Owner-only steps:
applying the two migrations (RUN-MIGRATION) and the production PUBLISH at Gate 2.

## Risks
- Freezing the home tenant for members with 0 or 2+ primary memberships is ambiguous → quarantine and resolve via
  mt-identity's membership unification first (hence the depends_on), never default to Maxina.
- Converting health readers behind a flag risks a split read if the flag flips mid-session → the accessor is
  deterministic per user, independent of session, so a flip changes only which tenant column is authoritative, not
  which rows a user sees.
- The lineage guard inventory is generated; a new tenant-analytics reader not yet in the inventory could slip through
  → the generator greps the full tree each build and the lane owns the generator, so a new reader is caught at build.

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
- Specs: mt-identity (`isHealthTable()`, membership unification, TenantContext, resolver); mt-tenant-admin (S-L);
  health-native (native app + health pipeline this contract wraps).
- Lanes (within this spec): health-tenant-accessor → health-home-tenant-db; health-analytics-lineage-guard →
  health-tenant-accessor; native-push-tenant → health-home-tenant-db.
- Done VTIDs built on: VTID-05177 (native token fields + `NATIVE_PUSH_DIRECT_ENABLED`), VTID-05149 (`tenants.is_default`).

## Owner decisions
Cited (already DECIDED, program register): D4 native iOS+Android, D8 one active tenant per session + health owned by
user, D17 native technology (recorded drift: the app is Expo/React Native, already built — not Capacitor; this does
not change D4/D8/D18), D18 tenant operators have no health access, D19 native delivery, D22 in-app payments
(untouched here). No new owner decision is proposed; the Capacitor→Expo correction is a factual drift note, not a
decision reversal.
<!-- plan:end -->

## Open questions for sparring
- Confirm the MIGRATION-QUEUE insertion point: mt-identity's membership-unification migrations are not yet numbered
  on origin, so health-home-tenant-db states a dependency rather than a fixed row number; the executor fixes the row
  once mt-identity's numbers land.
- Whether the frozen `health_home_tenant_id` should be re-keyed out entirely when Health Hub's user-keyed
  `health_observations` lands (program §9 target state) is tracked by health-native, not re-opened here.
