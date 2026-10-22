# Responses to sparring round 2 (session 2, `76c3c99c-cf9a-4e72-aec4-4995d7755ae7`)

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Verified services/automation-executor.ts: const lastHeartbeatRun: Record<string, number> at :386 is keyed by automation id only; runHeartbeatCycle(tenantId) (:392) reads it at :405 (skip when now - lastRun < intervalMs) and writes it at :418 (dedupeAcrossInstances branch) and :424. Calling it once per tenant in one tick would skip every tenant after the first. Fix (option a): the lane re-keys the map as `${tenantId}:${def.id}` at all three sites, so each tenant's heartbeat automations advance on their own interval; with one tenant (flag off) the skip/execute sequence is identical to today. The dedupeAcrossInstances branch already reads per-tenant run history (getRunHistory(tenantId, def.id, 1), :415). automation-executor.ts added to the jobs-tenant-loop paths (no other lane claims it). Jest: two active tenants with the same due heartbeat automation both execute it in one tick, then each waits its own interval; npm run test:operator stays green. Updated plan.md lane 2 + Tests, design.md, tasks.md L3b + paths, lane body/paths/log.",
    "deferred_to": null
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Verified each of the seven sites. Only community.ts:382 (/global-groups/:id/view) has an identity: requireAuth at :368, userId = req.identity.user_id at :381. Four are raw-bearer member routes with no req.identity: community.ts:274 (/groups/:id/join :206, getBearerToken :210), community.ts:482 (/global-groups/:id/join :412, userId decoded from the token sub at :427-429), match-feedback.ts:280 (/:id/feedback :110, token :115) and matchmaking.ts:576 (/:id/state :461, token :472). admin-signups.ts:205 is the public /log-result (:176-177, no identity; auth_user_id from the body :180, already sent as the event's user_id :211). groups-events-tools.ts:360 uses the ORB tool identity id. Fix: resolveActorTenant takes an explicit actor { tenantId, userId } and each site passes a named one: community.ts:382 => { tenantId: req.identity.tenant_id, userId: req.identity.user_id }; the four raw-bearer routes => { userId: jwtSubject(token) } (a shared helper equal to the decode the routes already do at community.ts:287/:429), read only after the route's user-scoped Supabase call (createUserSupabaseClient at community.ts:239/:442, match-feedback.ts:171, matchmaking.ts:492) has succeeded; /log-result => { userId: auth_user_id }, the NEW user, so the event is tagged with that user's primary tenant and never a caller's; groups-events-tools.ts:360 => { tenantId: id.tenant_id, userId: id.user_id }. Unresolvable => no tenant dispatch, logged, never Maxina. Trust is unchanged at /log-result (it already dispatches for any body auth_user_id) and a caller can never choose the tenant. Jest cases for /log-result (on: auth_user_id's primary tenant; off: DEFAULT_TENANT_ID) and a raw-bearer route. Updated plan.md lane 3 + Tests, design.md, tasks.md L2/A1/A2, both lane logs.",
    "deferred_to": null
  }
]
```
