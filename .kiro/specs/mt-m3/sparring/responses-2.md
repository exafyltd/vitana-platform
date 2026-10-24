# Responses to sparring round 2 — mt-m3 (session 8a83bc72)

Planner: kiro-hotmail-202610151618-b437. Premises re-verified against vitana-platform `origin/main`.

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Verified: services/gateway/src/middleware/auth-supabase-jwt.ts:525 (MembershipLookup 'member'|'not_member'|'unavailable'), :531-546 (lookupTenantMembership via repo.fetchMembershipForUserTenant under abortAfter, 60s positive cache :521-523), :641 (token arm uses it), :671-679 (applyTenantMembershipResult: 'unavailable' -> 503 TENANT_CHECK_UNAVAILABLE). No is_member() call in services/gateway/src. Plan Fix #2, Tests, Risks and Depends on now pin the host arm's re-check to lookupTenantMembership(user_id, host tenant_id) (exafy_admin skip as at :640; not_member -> join posture; unavailable -> fail-closed 503), with no new membership RPC. mt-identity is cited for TenantContext only. Tasks H2/H3 add the contract test (host-resolved tenant_id passed to lookupTenantMembership, repeat call hits its cache, no other membership query). Lane file, design and requirements updated to match.",
    "deferred_to": null
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Verified: reserved_tenant_slugs is a table (supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql:129 CREATE TABLE, :140 INSERT seed), and a Postgres CHECK cannot reference another table. Plan Fix #1 and task D1 now specify a BEFORE INSERT OR UPDATE OF host trigger tenant_domains_reject_reserved() that raises when EXISTS (SELECT 1 FROM reserved_tenant_slugs r WHERE r.slug = lower(btrim(NEW.host))); the host format stays a CHECK. Rollback drops trigger, function and table. Tests/D3 add pgTAP cases that INSERT and UPDATE of a reserved-slug host both raise. Lane file and design updated.",
    "deferred_to": null
  },
  {
    "finding_id": "R2-F3",
    "disposition": "accepted",
    "rationale": "Verified: getTenantContext (auth-supabase-jwt.ts:635-650) has only the token arm (identity.tenant_id + membership check, :639-646) and the primary fallback (resolvePrimaryTenantForRequest, :647-649); there is no slug or claim arm in the gateway. Plan Fix #2, Tests, task H1, the lane body, design and requirements R3 now say the host arm is a new first arm ahead of the unchanged token and primary arms. Wording-only change; the 'falls through to slug' wording that remains refers to the DB function resolve_tenant(p_host, p_slug) delegating to the 1-arg slug function, which is correct.",
    "deferred_to": null
  }
]
```
