# Sparring round 1 — in_progress

Session: `5e927bc9-b53f-44fe-8949-d8aee8d1a817` · plan hash `fb561ed01df09bce905d1866da3f4ee996b1eb5c9777071b50684f80efdf558d`

## Summary

The plan's core premises about the existing code are well-verified and hold up against the pinned commit. The notification token registration, tenant-filtered device-token fetch, health-repository `.single()` bug, conflict targets, session fallbacks, and push-routing call chain are all accurately described. The MIGRATION-QUEUE structure matches. The plan's architecture (frozen home tenant, healthDb accessor, inventory-first approach, dual-gated push widening) is sound. I found two minor issues worth noting but no blockers or major defects.

## Findings

### R1-F1 [minor]

The plan's (a)-class table list for health-tenant-accessor conversion names four tables (health_features_daily, vitana_index_scores, biomarker_results, wearable_workouts) across five repository files. However, the `recommendations` table is read without any tenant filter in health-repository.ts:62 (called from GET /summary at health.ts:536) and read WITH a tenant filter in health-wellness-repository.ts:84. It is not classified in the plan's (a)/(b)/(c) inventory and doesn't match the lineage guard's forbidden-set patterns (health_*/wearable_*/biomarker_*/lab_*/vitana_index_*). If `recommendations` is tenant-scoped health data, it should appear in the inventory with a classification. For a dual member, the unfiltered GET /summary query would return recommendations from both tenants (no crash since it uses .order() not .single(), but mixed-tenant results).

- `exafyltd/vitana-platform:services/gateway/src/routes/health-repository.ts:62` — export async function fetchRecommendationsForDate(sb: SupabaseClient, date: string) {
  return sb.from('recommendations').select('*').eq('date', date).order('priority', { ascending: false });
}
- `exafyltd/vitana-platform:services/gateway/src/services/automation-handlers/health-wellness-repository.ts:84` — export async function fetchRecentRecommendations(sb: SupabaseClient, tenantId: string, userId: string, limit: number) {
  return sb.from('recommendations').select('category, title').eq('tenant_id', tenantId).eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);

Suggestion: Add `recommendations` to the inventory with an explicit (a)/(b)/(c) classification. If it is health data, either add it to the forbidden-set predicate (`isHealthTable`) or convert its GET /summary reader to use `healthDb`. If it is intentionally outside scope, document the reason in the inventory entry.

### R1-F2 [minor]

The plan's native-tenant-isolation-tests lane makes multiple file-existence claims about vitana-v1 (TenantProvider.tsx, tenant-registry.ts, useMemberships.ts, resolve-link.ts, +native-intent.tsx, Maestro flows, tests/helpers/). These premises could not be verified: vitana-v1 has no pinned ref in this review session, and a search for 'TenantProvider tenant resolution' returned no hits. The plan does have a built-in safeguard ('missing file -> log it and park the lane, next_actor: owner'), which limits the blast radius, but the premises should be confirmed before the lane starts.

- `exafyltd/vitana-platform:services/gateway/src/services/push-routing.ts:1` — /**
 * Native push routing — VTID-05177 (native app Wave 1, N4-GW).
 *
 * dispatchPush() is the one push routing helper the three dispatch sites call:
 *   (a) notifyUser                 — services/notification-service.ts
 *   (b) POST /push-dispatch        — routes/scheduled-notifications.ts
 *   (c) scheduleReminderFcmPush    — services/reminders-dispatch.ts

Suggestion: Re-verify the vitana-v1 file paths against the actual pinned commit before the lane begins implementation. The park-on-missing safeguard is good; just ensure the premise verification is documented in the lane's pre-flight checklist.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
