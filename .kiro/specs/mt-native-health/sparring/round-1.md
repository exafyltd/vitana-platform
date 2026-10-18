# Sparring round 1 — in_progress

Session: `f554b163-4f6c-4780-86b2-a567de1ae7f9` · plan hash `c7dd2a224a27340223a2ee1a7026560a77f9d2db9a3314522d003efdbb35d2be`

## Summary

The plan correctly identifies the core health-tenancy and push-delivery problems and its DB lane (health-home-tenant-db) is structurally sound. However two blockers prevent safe implementation: vitana-v1 has no pinned commit in this review session so every premise about the native app is unverifiable; and the native-push-tenant fix's actual call site (notification-service-repository.ts:fetchLiveDeviceTokensForUser, shared with the legacy push path) is never named, making the flag-dark requirement impossible to satisfy without a described parallel code path. Four major gaps also need resolution before implementation begins.

## Findings

### R1-F1 [blocker]

vitana-v1 has no pinned commit in this review session. The plan's premises section states 'Premises re-verified against code at the branch tip on 2026-10-15' and names at least nine specific vitana-v1 file paths (TenantProvider.tsx, tenant-registry.ts, useMemberships.ts, resolve-link.ts, +native-intent.tsx, maestro/shell/08-tenants.yaml, maestro/10-deep-link-admin.yaml, tests/helpers/, apps/mobile/parity/ledger.json) that drive the entire native-tenant-isolation-tests lane. None were readable; the search for TenantProvider returned zero hits.

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:8` — Scope: both repos — `exafyltd/vitana-platform`… `exafyltd/vitana-v1` (src/hooks/useTenant, portals, AuthGuard, routing, i18n, supabase/functions), Supabase auth hook config, EventBridge scripts.
Baseline: vitana-platform `e9818e65`, vitana-v1 `e45fee2f`

Suggestion: Each of the nine vitana-v1 file paths must be verified against a pinned commit before the plan is approved. If the files do not exist as described, the native-tenant-isolation-tests lane's contract tests, fixture harness, and Maestro flows have no landing pad and cannot be implemented without first building missing infrastructure — which would exceed the declared standard change class.

### R1-F2 [blocker]

The native-push-tenant lane says 'drop the tenant filter on fetch' and gate behind MT_RESOLUTION_V2, but the actual function that filters tokens by tenant_id for all push delivery is notification-service-repository.ts:fetchLiveDeviceTokensForUser (line 41: .eq('tenant_id', tenantId)). This function is shared between the legacy push path and the native direct path. Modifying it without a flag changes ALL push delivery immediately; the plan never names this function nor describes a new parallel variant that can be flag-gated.

- `exafyltd/vitana-platform:services/gateway/src/services/notification-service-repository.ts:28` — export async function fetchLiveDeviceTokensForUser(
  sb: SupabaseClient,
  userId: string,
  tenantId: string,
  opts?: { withDeviceType?: boolean },
) {
  return sb
    .from('user_device_tokens')
    .select(opts?.withDeviceType ? 'fcm_token, device_label, device_type' : 'fcm_token, device_label')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .is('revoked_at', null);
}
- `exafyltd/vitana-platform:services/gateway/src/services/notification-service.ts:951` — const dispatched = await dispatchPush({
      userId,
      tenantId,
      payload,
      supabase,
      policy: {
        kind: 'deep_link_split',
        hasDeepLink: !!payload.data?.url,
        suppression: 'signed_out_or_lost_device',
        excludeAppilixTaggedOnFallback: true,
      },
- `exafyltd/vitana-platform:services/gateway/src/services/push-routing.ts:177` — nativeSent = await sendPushToUser(userId, tenantId, payload, supabase, {
        tokenClass: 'native',

Suggestion: The fix requires a NEW token-fetch variant — e.g. fetchLiveDeviceTokensForUserAcrossTenants(sb, userId) that omits .eq('tenant_id', tenantId) — used only on the native tokenClass pass when MT_RESOLUTION_V2 is on. The existing fetchLiveDeviceTokensForUser must remain unchanged for the legacy path. The plan must name notification-service-repository.ts as the file to change, specify the new function signature, and show how dispatchPush routes to it. Without this the flag-dark guarantee cannot be met.

### R1-F3 [major]

health-analytics-lineage-guard depends on isHealthTable() from mt-identity (CROSS-SPEC O1), which does not yet exist and has no VTID assigned, leaving the guard lane with no fallback if mt-identity is delayed.

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:117` — WS10 Health data × tenancy… tenant-admin/tenant-owner surfaces get a lint + test that no health table is readable through them (D18)
- `exafyltd/vitana-platform:services/gateway/src/services/automation-handlers/health-wellness-repository.ts:27` — export async function fetchPendingLabReports(sb: SupabaseClient, tenantId: string, limit: number) {
  return sb.from('lab_reports').select('id, user_id').eq('tenant_id', tenantId).is('parsed_json', null).limit(limit);
}

Suggestion: Either (a) define isHealthTable() as a hard-coded table-list constant within this spec and mark it as the CROSS-SPEC O1 contract surface (mt-identity later replaces it), or (b) assign a concrete VTID for the mt-identity slice that ships isHealthTable() and add a rollout gate: the guard CI step is warning-only until that VTID is merged, then promoted to build-failing. Without one of these the guard cannot compile.

### R1-F4 [major]

MULTI-TENANT-PLAN.md §6 WS9 still explicitly describes the native app as 'Capacitor iOS/Android projects around the SPA'. This spec records the drift to Expo/React Native only in its own premises section without updating the program document, so all future WS9 sub-plans and reviewers will inherit the Capacitor description.

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:116` — WS9 Native app shell, tenant-aware (with Health plan Phase 5): Capacitor iOS/Android projects around the SPA; port the Appilix bridge (push, drawer, share, IAP flags) to native plugins

Suggestion: This spec must include a PR that updates docs/MULTI-TENANT-PLAN.md §6 WS9 to replace the Capacitor description with the Expo/React Native reality, updates D17 in the decision register to record the technology as settled, and updates the plan-body hash on line 4. A drift note in a sub-plan's premises block is not a program-level correction.

### R1-F5 [major]

The build-failing health inventory lint requires ALL health table reads to go through healthDb(), but the plan only converts 5 repositories. wearables-repository.ts reads wearable_rollup_7d and wearable_daily_metrics with user_id only and is not in the conversion list; health-repository.ts reads vitana_index_scores with only date or user_id. The allowlist criteria are undefined, so the lint as written would break the build on day 1.

- `exafyltd/vitana-platform:services/gateway/src/routes/wearables-repository.ts:71` — export async function fetchWearableRollup7d(sb: SupabaseClient, userId: string) {
  return sb.from('wearable_rollup_7d').select('*').eq('user_id', userId).maybeSingle();
}

export async function fetchRecentWearableDailyMetrics(sb: SupabaseClient, userId: string, limit: number) {
  return sb
    .from('wearable_daily_metrics')
    .select('metric_date, provider, sleep_minutes, sleep_deep_minutes, hrv_avg_ms, resting_hr, active_minutes, workout_count, steps')
    .eq('user_id', userId)
    .order('metric_date', { ascending: false })
    .limit(limit);
}
- `exafyltd/vitana-platform:services/gateway/src/routes/health-repository.ts:51` — export async function fetchVitanaIndexScoreForDate(sb: SupabaseClient, date: string) {
  return sb.from('vitana_index_scores').select('*').eq('date', date).single();
}

Suggestion: The generated inventory must be produced first and each entry classified as: (a) converted to healthDb(), (b) allowlisted as a user-scoped read (wearable_rollup_7d, wearable_daily_metrics are already user_id-only per program plan §2 and need no home-tenant injection), or (c) allowlisted as a service-role platform job. The lint must begin as warning-only and be promoted to build-failing in the same PR that clears all (a) conversions — never before.

### R1-F6 [major]

The health_home_tenant_id backfill depends on canonical user_tenants.is_primary set by mt-identity's membership-unification rows. Those rows do not exist in MIGRATION-QUEUE.md (8 rows, all applied, none are membership-unification) and no VTID is assigned for that work, making the ordering constraint unenforceable.

- `exafyltd/vitana-platform:docs/multitenancy/MIGRATION-QUEUE.md:11` — Lane number ranges: S-M `20261013233000`; A `20261014000100`–`000300`;
B `20261014000400`–`000500`; C `20261014000600`–`000700`.
- `exafyltd/vitana-platform:services/gateway/src/services/automation-handlers/health-wellness-repository.ts:37` — export async function fetchPrimaryTenantUserIds(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('user_id').eq('tenant_id', tenantId).eq('is_primary', true);
}

Suggestion: The blocking mt-identity VTID must be assigned and its migration rows must appear in MIGRATION-QUEUE.md before this spec's rows are added. If that VTID is not yet planned, add a pre-check query to the migration that counts app_users with 0 or 2+ is_primary memberships and aborts (RAISE EXCEPTION) if the count is non-zero, preventing the backfill from running on a schema where is_primary has not been canonicalized.

### R1-F7 [minor]

The plan cites notifications.ts:32 as the location of NATIVE_PUSH_DIRECT_ENABLED. Line 32 is const NATIVE_APP_VERSION_RE, not the flag. The flag is imported at line 25 and checked at line 77.

- `exafyltd/vitana-platform:services/gateway/src/routes/notifications.ts:25` — import { isNativePushDirectEnabled } from '../services/native-push-flags';
- `exafyltd/vitana-platform:services/gateway/src/routes/notifications.ts:29` — const NATIVE_APP_VERSION_RE = /^[0-9A-Za-z.+-]+$/;
- `exafyltd/vitana-platform:services/gateway/src/routes/notifications.ts:77` — if (nativeDevice && !isNativePushDirectEnabled()) {

Suggestion: Correct the cited line numbers to notifications.ts:25 (import) and notifications.ts:77 (check). No functional impact.

### R1-F8 [minor]

native-push-tenant's depends_on: health-home-tenant-db is justified as 'shares the resolved-tenant helpers' but no shared helper module is named, designed, or referenced anywhere in the plan. push-routing.ts already carries tenantId as a plain parameter with no helper dependency.

- `exafyltd/vitana-platform:services/gateway/src/services/push-routing.ts:95` — export interface DispatchPushArgs {
  userId: string;
  tenantId: string;
  payload: NotificationPayload;
  supabase: Sb;
  policy: LegacyPushPolicy;

Suggestion: Either name and specify the shared helper module (what it exports, how both lanes use it), or remove the depends_on. A spurious dependency could hold up the native-push lane while health-home-tenant-db migrations are awaiting owner apply.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
