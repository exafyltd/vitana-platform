# Responses to sparring round 1
Session `fca982e6-f8a0-4fc9-8e6e-78d23ba39b48`. All four findings verified against platform origin/main and accepted;
plan.md, tasks.md, the affected lanes and handoff.md updated in the same push.
```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: notifyUser(userId, tenantId, type, payload) (notification-service.ts:809) writes one user_notifications row with tenant_id: tenantId (:889) and passes that ONE payload to dispatchPush (:951); sendPushToUser fetches tokens at :410-411. One notification belongs to one tenant, so the change only widens WHICH devices a notification reaches; it never re-derives copy per tenant. Took suggestion (b): the contract test is now 'ab_dual has ONE native device whose token row carries T_A; notifyUser(..., T_B, ...) reaches it with T_B's caller-built payload unchanged (today zero sends), and notifyUser(..., T_A, ...) still reaches it with T_A's'. Per-tenant copy for a single notification is stated out of scope. Also fixed a gap this exposed: the fetch lives inside sendPushToUser, so notification-service.ts joins the native-push-tenant paths for an acrossTenants opt that the native pass (push-routing.ts:177) sets only when MT_RESOLUTION_V2 is on (tasks P2/P4).",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified integrations-repository.ts:67-68 fetchUserTenantId and health-repository.ts:68-69 fetchTenantIdForUser both use user_tenants .limit(1).maybeSingle() with no is_primary ordering, so the off-path is an arbitrary row and a flip IS a behaviour change for a dual member. The Risks bullet is rewritten to say so. Mitigation: flag off keeps today's path exactly (changing the off-path ordering would itself be an undarked behaviour change, so it is not done); the flip is gated on the backfill post-check; a read-only pre-flip count of dual members with health rows outside their home tenant is recorded in docs/validation/<VTID>/; rows under another tenant are left unread, never deleted, and merging them is Health Hub's re-key (out of scope).",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Accepted, with the fix aligned to the binding cross-spec ruling O1 (mt-native-health references mt-identity's isHealthTable(), never its own list). The local HEALTH_TABLES constant is removed. The guard imports isHealthTable from services/gateway/src/services/tenancy/is-health-table.ts, the path owned by lane mt-identity/tenant-db-and-slug-cleanup (verified on origin/kiro/mt-identity/plan, lanes/tenant-db-and-slug-cleanup.md paths). The lane states this as a cross-spec dependency and is held until that file is on main (cross-spec ids cannot go in depends_on: queue.mjs validateLane:184 rejects non-spec lanes). The generated inventory is committed as services/gateway/test/mt-native-health/health-lineage-inventory.json (added to lane + tasks paths); the test regenerates it, fails on drift, and filters table names through isHealthTable(), so the predicate and inventory cannot silently diverge.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Verified the two writers: upsertHealthFeatureDaily at integrations-repository.ts:72 (upsert :85) and diary-health-extractor-repository.ts:23 (upsert :24), both onConflict 'tenant_id,user_id,date,feature_key', so session-tenant and home-tenant writes are two rows. The plan now makes the write-path conversion explicit: writers and readers convert in ONE PR behind ONE flag (MT_RESOLUTION_V2), so write tenant and read tenant always come from the same resolver; the flip waits for the backfill post-check; the Risks bullet documents that rows written under another tenant stay as a separate, unread series (tasks A2).",
    "deferred_to": null
  }
]
```
