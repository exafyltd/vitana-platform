# Round 1 responses (session 2d859993-c312-448c-92f4-d1e53f68e147)

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: discovery-tools.ts groups/products/services lanes are gated on id.tenant_id (:225,:229,:241,:251) via searchTenantGroups/Products/Services; only people (:172), posts (:198) and events (searchUpcomingEventsForGlobalSearch :214) are unscoped. Narrowed problem #1 and the community-scope-gateway fix list to name those three lanes only and explicitly leave groups/products/services untouched.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified: social-memory-repository.ts:487 fetchUpcomingEvents(limit = 40) has no tenantId param; social-context-builder.ts:141 and tool_browse_news_feed call it with limit only. Plan Fix (e) and premise 3 now state fetchUpcomingEvents gains a tenantId parameter (breaking signature change) and every caller is audited to pass TenantContext.tenantId.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified: migration :117 is pg_advisory_xact_lock(hashtext('vtid_04859_founding_1000')) — a single platform-wide key, with max(seat_number)+1 under it (:131). Plan Fix (founding lane), premise 5, Tests and the founding-pool-tenant-db lane now mandate a per-tenant lock key hashtext('vtid_04859_founding_1000_' || p_tenant_id::text), state why keeping the global key (serialisation) or dropping it (same-tenant race into UNIQUE(tenant_id,seat_number)) is wrong, clarify 'per-tenant sequence' means per-tenant max+lock not a SEQUENCE object, and add a pgTAP concurrency test.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Verified: users-resolve-repository.ts:17 passes p_global:false; the RPC (20260812140200_VTID_03623_resolver_drift_fix_chat_peer_flag.sql) resolves the actor's tenant internally and p_global DEFAULT false restricts to it. resolve_recipient_candidates is already community-scoped. Removed it from the community-scope-gateway code fix list; it is now listed as verified-already-scoped with a read-only assertion test only, no code change.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Verified: social-memory-repository.ts:420 fetchCandidatePosts(userId, followedIds, excl, limitPerSource=40) reads profile_posts with no tenant filter; callers social-context-builder.ts:141 and tool_browse_news_feed pass no tenant. Plan premise 3 and Fix (e) now name fetchCandidatePosts/profile_posts explicitly, require a tenantId parameter, update both callers, and add a Vitest that both the social context feed and the news-feed tool return only the active tenant's posts with the flag on.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F6",
    "disposition": "accepted",
    "rationale": "Verified: community-member-ranker-repository.ts:87 reads community_groups and community_group_members, DISTINCT from global_community_*. community_groups already has tenant_id NOT NULL + tenant-aware RLS (20251231100000_vtid_01084_community_personalization_v1.sql:35,133,146-147), so it needs NO column/RLS add — only the ranker query applying the filter. community_group_members has no migration in the tree (best-effort read). Added premise 8 and scoped the ranker's community_groups filter into community-scope-gateway (not into the DB column-add lane), per the finding's correct distinction.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F7",
    "disposition": "accepted",
    "rationale": "Verified: :60 is CREATE POLICY founding_members_select_own, the function starts at :66, tenant resolution from user_tenants is :107-115. Corrected the citation in premise 5 and the founding-pool-tenant-db lane to :66,107-115 and noted :60 is the RLS policy.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F8",
    "disposition": "accepted",
    "rationale": "Verified: social-memory-service.ts:26 AssistantSocialContextInput.tenant_id and social-context-builder.ts:92,141 already use input.tenant_id (the session's active tenant), so a source swap is a no-op. Restated the fix in premise 3 and Fix as a MEMBERSHIP CHECK: verify input.tenant_id is an active membership via WS1 is_member() before any read and reject a caller override; the Vitest asserts rejection of a non-member tenant, not mere source origin.",
    "deferred_to": null
  }
]
```
