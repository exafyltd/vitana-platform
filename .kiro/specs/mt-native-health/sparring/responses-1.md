# Responses to sparring round 1

Session `f554b163-4f6c-4780-86b2-a567de1ae7f9`. Every finding verified against code and accepted; plan.md, tasks.md
and the affected lanes updated in the same push.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "The reviewer had no vitana-v1 pin, so the nine native paths were unverifiable to it. I verified them against exafyltd/vitana-v1 origin/main on 2026-10-15: apps/mobile/src/identity/TenantProvider.tsx, tenant-registry.ts, useMemberships.ts, src/linking/resolve-link.ts, app/+native-intent.tsx, maestro/shell/08-tenants.yaml, maestro/shell/10-deep-link-admin.yaml, tests/helpers/, apps/mobile/parity/ledger.json all exist (full apps/mobile tree read). Added a vitana-v1 verification pin to Problem #4 (baseline e45fee2f) plus docs/validation/<VTID>/vitana-v1-premises.md so a reviewer without a vitana-v1 pin can confirm; the native lane adds TESTS only and hands back (next_actor: claude) if any file is absent at implementation time rather than building app infrastructure.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified notification-service-repository.ts:28 fetchLiveDeviceTokensForUser reads user_device_tokens with .eq('user_id'):40 AND .eq('tenant_id'):41, and is shared by the legacy and native paths (notification-service.ts:951, push-routing.ts:177). The plan now specifies a NEW variant fetchLiveDeviceTokensForUserAcrossTenants(sb, userId, opts?) that omits the tenant filter, called only on the native tokenClass pass when MT_RESOLUTION_V2 is on, leaving the existing function unchanged for the legacy path; push copy/deep-link come from the notification row's tenant_id (dispatchPush arg, push-routing.ts:95). Lane paths narrowed to notification-service-repository.ts + push-routing.ts + the test; tasks P1-P4 and the lane body name the function and the flag-dark routing.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Confirmed isHealthTable() has zero matches in gateway/migrations and mt-identity has no VTID. The health-analytics-lineage-guard lane now ships a local HEALTH_TABLES constant marked '// CROSS-SPEC O1: mt-identity replaces this with isHealthTable()' as the contract surface, and the guard CI step is warning-only until health-tenant-accessor's (a) conversions merge, then build-failing. This removes the hard block on mt-identity; the dependency is recorded as SOFT in 'Depends on'.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Confirmed docs/MULTI-TENANT-PLAN.md §6 WS9 still says 'Capacitor iOS/Android projects around the SPA' while the app is Expo/React Native (apps/mobile/). A drift note in a sub-plan is not a program-level correction. Added task H5 and docs/MULTI-TENANT-PLAN.md to the health-home-tenant-db lane's allowed paths: its PR updates §6 WS9 to the Expo reality, records D17 as settled in the decision register, and recomputes the plan-body hash on line 4. docs/MULTI-TENANT-PLAN.md is a program doc, not a governance path, so an executor: kiro lane may change it.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Verified wearables-repository.ts:72 wearable_rollup_7d and :77 wearable_daily_metrics are user_id-only, and health-repository.ts:51 fetchVitanaIndexScoreForDate reads vitana_index_scores by date only — a build-failing lint over only 5 converted repos would break the build on day 1. tasks A3/A4 now require the inventory to be GENERATED FIRST and each entry classified (a) convert-to-healthDb, (b) user-keyed-already (wearable_rollup_7d, wearable_daily_metrics), or (c) service-role job; the lint ships warning-only and is promoted to build-failing in the SAME PR that clears every (a) conversion.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F6",
    "disposition": "accepted",
    "rationale": "Confirmed MIGRATION-QUEUE.md has 8 rows, all applied, none membership-unification, and mt-identity has no VTID — so the 'after mt-identity' ordering is unenforceable by position alone. Added a RAISE EXCEPTION guard at the top of the backfill migration (task H2) that aborts unless every member has exactly one primary user_tenants row, so the backfill refuses to run until is_primary is canonical. The queue position becomes an ordering preference, not a hard blocker; the spec is implementable regardless of mt-identity's schedule.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F7",
    "disposition": "accepted",
    "rationale": "Verified notifications.ts:25 imports isNativePushDirectEnabled from ../services/native-push-flags, :29 is NATIVE_APP_VERSION_RE, and the flag is checked at :77 — my cited :32,71-78 was wrong. Problem #3 now cites notifications.ts:25 (import) and :77 (check). No functional impact.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F8",
    "disposition": "accepted",
    "rationale": "Confirmed push-routing.ts carries tenantId as a plain DispatchPushArgs parameter (push-routing.ts:95) with no helper dependency on the frozen health home tenant; native-push derives the tenant from the notification row, not from health_home_tenant_id(). The depends_on: [health-home-tenant-db] was spurious and is removed (lane now depends_on: []); the plan, lane body and log state native-push-tenant is independent.",
    "deferred_to": null
  }
]
```
