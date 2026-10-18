# Tasks — mt-native-health

Authoritative plan: `plan.md`. Lane files: `lanes/`. VTID: allocated by PLAN-SPAR after approval.

<!-- lane: health-home-tenant-db -->
## health-home-tenant-db — frozen health home tenant (DB) (repo vitana-platform)

Allowed paths:
- `supabase/migrations/20261101130000_*.sql`
- `supabase/migrations/20261101130100_*.sql`
- `docs/multitenancy/MIGRATION-QUEUE.md`
- `docs/MULTI-TENANT-PLAN.md`
- `services/gateway/test/mt-native-health/health-home-tenant.pgtap.sql`

- [ ] H1 Migration `20261101130000_*`: add `app_users.health_home_tenant_id uuid NULL REFERENCES tenants(id)` + index.
- [ ] H2 Migration `20261101130100_*`: `health_home_tenant_id(p_user uuid)` STABLE SECURITY DEFINER resolver
      (`coalesce(column, primary user_tenants row)`, never reads `app_metadata`); batched backfill with `lock_timeout`,
      snapshot to a `bak_*` table (30-day retention); leave NULL for members with 0 or 2+ primary memberships.
      Open the backfill with a `RAISE EXCEPTION` guard that aborts unless every member has exactly one primary
      `user_tenants` row (round-1 F6: self-enforces mt-identity ordering).
- [ ] H3 Add the two rows to `docs/multitenancy/MIGRATION-QUEUE.md` AFTER mt-identity's membership-unification rows,
      with depends-on, rollback path and read-only pre/post-check references.
- [ ] H4 pgTAP: resolver is stable across sessions for ab_dual; backfill idempotent; ambiguous members stay NULL.
- [ ] H5 Round-1 F4 program-doc correction: in `docs/MULTI-TENANT-PLAN.md`, replace §6 WS9's "Capacitor iOS/Android
      projects around the SPA" with the verified reality (Expo/React Native, `apps/mobile/`), record D17 as settled
      in the decision register, and recompute the plan-body hash on line 4.

Acceptance: migrations are expand-only and reversible (`docs/validation/<VTID>/rollback.sql`); pre-check counts
ambiguous members; post-check asserts every member has a home tenant or is quarantined; pgTAP green; MIGRATION-QUEUE
row present. Kiro never applies the migration — Claude applies via RUN-MIGRATION after merge. The lane adds its own
`docs/validation/<vtid>/`.

<!-- lane: health-tenant-accessor -->
## health-tenant-accessor — user-keyed healthDb accessor + inventory lint (repo vitana-platform)

Allowed paths:
- `services/gateway/src/data/health-db.ts`
- `services/gateway/src/routes/integrations-repository.ts`
- `services/gateway/src/services/diary-health-extractor-repository.ts`
- `services/gateway/src/routes/health-repository.ts`
- `services/gateway/src/services/automation-handlers/health-wellness-repository.ts`
- `services/gateway/src/services/automation-handlers/health-action-initiative-repository.ts`
- `services/gateway/scripts/gen-health-reader-inventory.mjs`
- `services/gateway/test/mt-native-health/health-reader-inventory.test.ts`
- `services/gateway/test/mt-native-health/health-db.test.ts`

- [ ] A1 `health-db.ts`: `healthDb(userId)` resolving the frozen home tenant via `health_home_tenant_id()`; dark
      behind `MT_RESOLUTION_V2` (off = current session-tenant behaviour).
- [ ] A2 Convert the two writers and three readers above to route through `healthDb` instead of a session tenant.
- [ ] A3 `gen-health-reader-inventory.mjs`: generate the inventory of `.from('<health table>')` sites across
      `services/gateway/src` FIRST; classify each entry (a) convert-to-`healthDb`, (b) user-keyed-already (e.g.
      `wearables-repository.ts:72` `wearable_rollup_7d`, `:77` `wearable_daily_metrics` — `user_id`-only), or
      (c) service-role job. Table set from mt-identity's `isHealthTable()` (round-1 F5).
- [ ] A4 `health-reader-inventory.test.ts`: lint ships WARNING-ONLY and is promoted to build-failing in the SAME PR
      that clears every (a) conversion (round-1 F5); allowlist = (b)+(c) + the accessor; fails on a planted
      session-tenant health read once promoted.
- [ ] A5 `health-db.test.ts`: `healthDb` resolves the same tenant for a dual member in either session.

Acceptance: Vitest green incl. the new lint; the five repos no longer read a session tenant for health; flag off
preserves today's behaviour; `npm run test:support` / `npm run test:operator` green if the touched code intersects
them. depends_on health-home-tenant-db. The lane adds its own `docs/validation/<vtid>/`.

<!-- lane: health-analytics-lineage-guard -->
## health-analytics-lineage-guard — tenant-analytics/commerce health-read guard (repo vitana-platform)

Allowed paths:
- `services/gateway/scripts/gen-health-lineage-inventory.mjs`
- `services/gateway/test/mt-native-health/health-lineage-guard.test.ts`
- `services/gateway/test/mt-native-health/health-lineage-guard.pgtap.sql`
- `services/gateway/src/constants/health-lineage-exempt.ts`

- [ ] G1 `gen-health-lineage-inventory.mjs`: generate the tenant-analytics + commerce reader module inventory
      (tenant-admin overview/KPIs/health-index, tenant-owner analytics, exports, Discover feed/search, ORB
      product/cart tools, autopilot offers).
- [ ] G2 `health-lineage-exempt.ts`: the explicit member-coaching exemption list (community-autopilot scan, news
      feed, morning brief, health-wellness/health-action automations), each with a one-line reason.
- [ ] G3 `health-lineage-guard.test.ts`: guard that no inventoried, non-exempt module reads a table in the forbidden
      set; planting a health read in a tenant-analytics module fails. The forbidden set is a local `HEALTH_TABLES`
      constant marked `// CROSS-SPEC O1: mt-identity replaces this with isHealthTable()` (round-1 F3: no hard block
      on mt-identity); warning-only until health-tenant-accessor's (a) conversions merge, then build-failing.
- [ ] G4 `health-lineage-guard.pgtap.sql`: a T_B tenant admin reads zero rows of each health table.

Acceptance: guard fails on a planted violation and passes on the current tree; exemptions justified; pgTAP green.
depends_on health-tenant-accessor. References mt-identity's `isHealthTable()` — never re-lists health tables. The
lane adds its own `docs/validation/<vtid>/`.

<!-- lane: native-push-tenant -->
## native-push-tenant — per-tenant native push (repo vitana-platform)

Allowed paths:
- `services/gateway/src/services/notification-service-repository.ts`
- `services/gateway/src/services/push-routing.ts`
- `services/gateway/test/mt-native-health/native-push-tenant.test.ts`

- [ ] P1 Add `fetchLiveDeviceTokensForUserAcrossTenants(sb, userId, opts?)` in `notification-service-repository.ts`
      (identical to `fetchLiveDeviceTokensForUser:28` but WITHOUT `.eq('tenant_id', tenantId):41`); leave the
      existing function UNCHANGED (round-1 F2 — it is shared by the legacy path).
- [ ] P2 Route the native `tokenClass` pass (`push-routing.ts:177`) to the new variant only when `MT_RESOLUTION_V2`
      is on; derive each push's copy and deep link from the notification row's `tenant_id` (`dispatchPush` arg,
      `push-routing.ts:95`), not the token's stored tenant.
- [ ] P3 Preserve the one-active-transport-per-device invariant (`appilix` | `native`); dark behind
      `NATIVE_PUSH_DIRECT_ENABLED` (native) and `MT_RESOLUTION_V2` (across-tenant fetch).
- [ ] P4 Contract test: ab_dual with one registered device receives a push from each tenant with that tenant's copy
      and deep link; the legacy path (flag off) is unchanged.

Acceptance: Vitest/contract green; token fetch is user-keyed; delivery copy/link follows the notification tenant;
flags off preserve today's behaviour. depends_on health-home-tenant-db (shared resolved-tenant helper). The lane adds
its own `docs/validation/<vtid>/`. (Executor: verify the exact repository file names at implementation time; the
allowed paths list the current notification repos — narrow to the real ones in the lane PR.)

<!-- lane: native-tenant-isolation-tests -->
## native-tenant-isolation-tests — native tenancy contract tests (repo vitana-v1)

Allowed paths:
- `apps/mobile/tests/mt-native-health/tenant-resolution.test.tsx`
- `apps/mobile/tests/mt-native-health/deep-link-nonmember.test.tsx`
- `apps/mobile/tests/mt-native-health/push-identity.test.ts`

- [ ] N1 `tenant-resolution.test.tsx`: the resolved tenant comes only from the JWT claim path
      (`src/identity/TenantProvider.tsx`), never from `device-storage`/deep-link slug alone.
- [ ] N2 `deep-link-nonmember.test.tsx`: a deep link to a tenant the member does not belong to resolves to the
      "join this community" screen and fetches no tenant data (`src/linking/resolve-link.ts`).
- [ ] N3 `push-identity.test.ts`: push registration (`src/push/registration.ts`) sends only `user_id`-scoped
      identity, no client-chosen tenant.

Acceptance: `npm test` (apps/mobile Jest) green; tests use the existing fake-gateway/fixture harness
(`tests/helpers/`), fixture tenants T_A/T_B; no production calls; no app source changed (tests only — if a test
reveals a real source gap, log it and set `next_actor: claude`, do not expand scope). The lane adds its own
`docs/validation/<vtid>/` under vitana-v1.
