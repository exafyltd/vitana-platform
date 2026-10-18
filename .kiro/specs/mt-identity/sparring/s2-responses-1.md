# Sparring session 2 — responses to round 1
Session: `2cc96038-ed5f-40e6-b7df-b6595046f5a7`

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Correct and important. The net-new tenant_claim_mismatch_log table had no access-control spec; with RLS off (or on with no policy, which denies) the authenticated PostgREST role could read every user's shadow-claim rows, and the N3 lint only counts bare current_tenant_id() policies on existing tables so it would not catch this. Verified the sibling pattern: supabase/migrations/20261014000300_vtid_05149_ci_tenant_isolation_health.sql:1 is deliberately counts/names-only, never row content — this log must be at least as tight. Added service-role-only posture to plan.md Fix #3 and lanes/access-token-hook-shadow.md: the ...032100 migration REVOKEs ALL from PUBLIC/anon/authenticated, GRANTs ALL to service_role, ENABLEs RLS with NO policy (RLS then denies all non-service-role reads); added a pgTAP test asserting the authenticated deny and the service_role admit.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "The partner is right and this corrects my own round-2 over-reach. Re-read services/gateway/src/services/orb-memory-bridge.ts:66-72: DEV_IDENTITY is a single exported dev-user struct (USER_ID '…0099') pinned to TENANT_ID='…0001'/TENANT_SLUG='vitana' — not a map, with no 0002/0003/0004 entries, used as the fallback identity when a sandbox request has no authenticated session. Only me.ts:15/:23 and dev-auth.ts:26 are four-entry maps. Split plan.md Problem #5 and Fix #5 (and the lane) into two shapes: (a) the two four-entry slug maps + limit(1) are removed, resolving through the DB registry + TenantContext; (b) DEV_IDENTITY.TENANT_ID/TENANT_SLUG is driven by a DEV_TENANT_SLUG env var defaulting to vitana (DB-registry-backed in the sandbox), keeping the pinned dev user …0099, with a test that no …0001 literal survives outside the resolved default and the two slug-map sites.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Reasonable. Verified auth-supabase-jwt-repository.ts:16-22 only mentions 'the tenantDb slice' as a future concept via the fetchPrimaryTenantForUser doc-comment; TENANT_TABLES/isHealthTable/healthDb have no textual anchor in the file, and other specs depend on O1. Spelled out the O1 contract in plan.md Fix #5 and the tenant-db lane as explicit TypeScript signatures: type TENANT_TABLES (schema-derived), isHealthTable(tableName: string): boolean, tenantDb(ctx: TenantContext), healthDb(userId: string), so downstream specs reference a named contract rather than an implicit one.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Technically correct. (select tenant_id_for_policies()) is uncorrelated and hoists to an initPlan; (select is_member(tenant_id)) in a tenant-shared USING clause references the outer table column, so it is correlated and runs once per row regardless of the (select …) wrapper. The hot tables named (user_notifications/chat_messages) use the user-private policy, so the initPlan claim does hold for them. Split the cost claim in plan.md Fix #1 into the two cases and stated the per-row is_member() cost is acceptable because it is STABLE SECURITY DEFINER over the unique (tenant_id,user_id) index (one index probe/call); added an EXPLAIN-based test bounding the per-row cost on the largest tenant-shared table (live_rooms).",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Correct and well-grounded in the program's own canonical risk. The plan guarded only the one-off backfill, not the steady-state dual-write trigger; a legacy idempotent re-insert of an existing memberships row could re-fire the four user_tenants AFTER INSERT triggers (the VTID-03990 duplicate-welcome-DM shape, docs/MULTI-TENANT-PLAN.md:41 and §3/S-E). Specified in plan.md Fix #2 and lanes/membership-unification.md that the trigger body uses INSERT INTO user_tenants … ON CONFLICT (tenant_id, user_id) DO NOTHING (the user_tenants_tenant_id_user_id_key unique index exists), and added a pgTAP test that re-inserting a known row creates zero additional chat_messages, founding seats, autopilot rows and live rooms — the §3/S-E contract applied to the ongoing trigger path.",
    "deferred_to": null
  }
]
```
