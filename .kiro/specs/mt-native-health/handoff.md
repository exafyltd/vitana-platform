---
slug: mt-native-health
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-20T09:00Z
---
# Handoff — mt-native-health (multi-tenant program WS9 tenancy delta + WS10 health×tenancy)

Planner: Kiro seat `hotmail`, session `kiro-hotmail-202610151618-b437`. Program plan:
`docs/MULTI-TENANT-PLAN.md` (authoritative; decisions D1–D27/N1–N3 taken). This spec owns ONLY the
**multi-tenancy contract** for the native app and for health data — the WS9 native tenancy delta and the
WS10 health×tenancy contract. It does NOT build the native app or the health-data pipeline: those are the
separate `health-native` spec (Native app VTID-05021 + Health Hub VTID-05020,
`docs/programs/native-app/NATIVE-APP-PLAN.md`, `docs/programs/health-hub/HEALTH-HUB-PLAN.md`). mt-native-health
is the tenancy layer those two programs consume.

## Premise drift corrected (verified against code 2026-10-15, binding)
- **The native app is Expo / React Native, not Capacitor.** `apps/mobile/` in vitana-v1 is a built Expo Router app
  (`app.config.ts`, `app/(app)/[...path].tsx`, `modules/vitana-voice/` native Swift+Kotlin, Maestro flows), with a
  tenant layer already present (`src/identity/TenantProvider.tsx`, `tenant-registry.ts`, `useMemberships.ts`), push
  (`src/push/registration.ts`), deep links (`src/linking/resolve-link.ts`, `app/+native-intent.tsx`) and tenant +
  deep-link Maestro flows (`maestro/shell/08-tenants.yaml`, `10-deep-link-admin.yaml`). Program plan §8/D17's
  "Capacitor shell" is drift. This spec therefore plans the tenancy **contract and verification** on the existing
  app, not shell construction.
- **Native push transport is already partly built.** `services/gateway/src/routes/notifications.ts` (VTID-05177)
  already added native token fields and `NATIVE_PUSH_DIRECT_ENABLED`; but `/token` still writes
  `tenant_id: identity.tenant_id` on each registration (`notifications.ts:107-110`) and
  `user_device_tokens_one_active_owner` keys one active row per (user, token). The per-tenant-push-copy fix is a
  delta on this, not greenfield.
- **Health identity is keyed by tenant today.** `health_features_daily` upserts on
  `onConflict: 'tenant_id,user_id,date,feature_key'` (`integrations-repository.ts:85`,
  `diary-health-extractor-repository.ts:24`); writers resolve the tenant via a `limit(1).maybeSingle()` session
  fallback (`integrations-repository.ts:67-68`, `health-repository.ts:68-69`); readers take the session `tenantId`
  (`health-wellness-repository.ts:44,50`, `health-action-initiative-repository.ts:54,60`). `health_home_tenant_id`,
  `healthDb`, `TENANT_TABLES` and `isHealthTable` do NOT exist yet (verified: no matches in gateway/migrations).

## Lanes
- `health-home-tenant-db` — DB: `app_users.health_home_tenant_id` + backfill + `health_home_tenant_id(user_id)`
  resolver (expand/contract). executor kiro, seat hotmail, reviewer jtadic, repo vitana-platform.
- `health-tenant-accessor` — gateway `healthDb(userId)` accessor + convert the verified health writers/readers +
  generated reader/writer inventory + lint. executor kiro, seat jtadic, reviewer hotmail, repo vitana-platform.
  depends_on: health-home-tenant-db.
- `health-analytics-lineage-guard` — build-failing guard that tenant-analytics/commerce reader surfaces never read
  health_*/wearable_*/biomarker_*/lab_*/vitana_index_* (D18); references mt-identity `isHealthTable()`. executor
  kiro, seat jtadic, reviewer hotmail, repo vitana-platform. depends_on: health-tenant-accessor.
- `native-push-tenant` — gateway: device tokens fetched by user_id only; per-recipient tenant copy + deep link from
  the notification row's tenant; transport one-owner; ab_dual contract test. executor kiro, seat jtadic, reviewer
  hotmail, repo vitana-platform. depends_on: health-home-tenant-db (shares the TenantContext helpers).
- `native-tenant-isolation-tests` — vitana-v1 `apps/mobile`: tenancy contract tests on the existing app (claim is the
  only resolution source; T_B deep link for a T_A-only member → join screen, no data fetched; ab_dual push copy).
  executor kiro, seat exafyltd, reviewer hotmail, repo vitana-v1.

## Depends on (other specs)
- mt-identity — owns `isHealthTable()` predicate (CROSS-SPEC O1), the access-token hook, `tenant_id_for_policies()`,
  TenantContext/`resolvePrimaryTenant()`. This spec references them, never redefines them.
- mt-tenant-admin — owns S-L (removing the tenant-admin partner-health scope); the lineage guard here complements it.
- health-native — owns the native app build and the health-data pipeline this contract wraps.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → drafted
Spec drafted by the hotmail Kiro seat as the WS9/WS10 tenancy contract. Premises re-verified against code
(native app is Expo not Capacitor; health identity tenant-keyed; `health_home_tenant_id`/`healthDb`/
`isHealthTable` absent). Pushed as a `plan(mt-native-health)` PR for PLAN-SPAR. Lanes are HELD (`next_actor: owner`
in each lane) until PLAN-SPAR allocates the VTIDs.

### 2026-10-18T21:40Z · kiro-hotmail-202610151618-b437 · answered sparring round-1
Round-1 (session f554b163) returned 8 findings (2 blocker, 4 major, 2 minor); the earlier escalation was an infra
throttle only (Bedrock daily-token limit) and is resolved. All 8 verified against code and ACCEPTED; answers in
`sparring/responses-1.md`. Changes applied to `plan.md`/`tasks.md`/lanes: named `fetchLiveDeviceTokensForUser`
+ the new across-tenant variant and dropped the spurious native-push→health-home dependency (F2/F8); inventory
generated-first + warning-until-conversions-clear (F5); local `HEALTH_TABLES` fallback for `isHealthTable()` (F3);
backfill `RAISE EXCEPTION` guard self-enforcing membership canonicality (F6); program-doc §6 WS9 Capacitor→Expo
correction + D17 + plan-body hash added to the DB lane (F4); vitana-v1 premises pin recorded (F1); notifications
flag line numbers corrected to :25/:77 (F7). Next: PLAN-SPAR round-2 on the updated plan.

### 2026-10-18T20:09Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:17Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:25Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:32Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:46Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
### 2026-10-20T09:00Z · kiro-hotmail-202610151618-b437 · drafted (answered sparring round 1, session fca982e6)
All four findings accepted. R1-F1: one notification = one tenant; contract test narrowed, `notification-service.ts`
added to native-push-tenant for an `acrossTenants` opt on `sendPushToUser`. R1-F2/F4: risk rewritten (`limit(1)`
off-path vs frozen home tenant); writers+readers flip together behind one flag, after the backfill post-check, with a
read-only pre-flip count. R1-F3: local `HEALTH_TABLES` dropped per CROSS-SPEC O1; guard imports mt-identity's
`isHealthTable` (stated cross-spec dependency) and commits its inventory as a fixture. Also dropped the earlier F4 edit
of the hash-locked `docs/MULTI-TENANT-PLAN.md`. Next: PLAN-SPAR round 2.
### 2026-10-20T10:00Z · kiro-hotmail-202610151618-b437 · drafted (answered sparring round 2, session fca982e6)
R2-F1 accepted: `fetchVitanaIndexScoreForDate` gets an explicit (a) disposition with a `(sb, userId, date)` signature;
`routes/health.ts` (its sole caller, GET /summary) added to health-tenant-accessor's paths.
