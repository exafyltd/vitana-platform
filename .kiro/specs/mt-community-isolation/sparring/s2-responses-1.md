# Round 1 responses (session ed136e24-677b-483e-92ea-78045c7b4748)
```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: global_community_profiles has user_id UUID NOT NULL UNIQUE (vitana-v1 supabase/migrations/20250917153624_*.sql:7) while user_tenants is 1:N (UNIQUE (tenant_id, user_id), 20251231000000_vtid_01101_phase_a_bootstrap.sql:89-98) and is_primary has no uniqueness constraint. Plan (problem #4, Fix community-tenant-db, Tests) and tasks T1/T2/T3/T5 + the community-tenant-db lane now split tables into three classes: per-user global_community_profiles gets NO tenant_id and is scoped by an EXISTS user_tenants membership predicate (visible in every tenant the user belongs to); child global_community_group_members copies its parent group's tenant_id (deterministic); content tables backfill deterministically (author's only membership, else single is_primary, else left NULL with author-only read; CHECK validated only when the NULL count is 0). pgTAP covers a two-tenant member and an ambiguous author.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified social-memory-repository.ts: fetchPeople :72, fetchFollowEdges :126, fetchMatches :169, fetchPersonPosts :472, fetchEventParticipants :500, fetchEventsForUsers :521, fetchGroupsForUsers :539, fetchGroupNames :557, fetchEventTitles :570, fetchInterests :583, resolvePersonByName :649, fetchPersonById :679 carry no tenant predicate. Plan Fix (e) and tasks G2 now enumerate every one, each gaining a tenantId parameter, and list every importer (incl. routes/memory-social.ts, intent-find-match.ts:277, orb-tools/p0-gap-tools.ts:71, which were added to the lane paths). Explicitly out of scope with reason: fetchExclusions :99 / fetchFollowFlags :622 / fetchActiveLifeCompassGoal :685 are viewer-own (.eq('user_id', userId)); chat_* reads are already .eq('tenant_id') (:259,:337,:378,:612,:710) and chat scope belongs to the Network sibling spec. Vitest has one case per reader.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified superlatives-repository.ts:35 fetchTopVitanaIndexScores and community-members-repository.ts:27 countProfilesExcludingSelf read per-user tables with no tenant column. Plan Fix now defines exactly two mechanisms: (M) member-id scope via one helper fetchActiveTenantMemberIds(sb, tenantId) in community-members-repository.ts (user_tenants.user_id WHERE tenant_id = $1) applied as .in(<user-id column>, memberIds) BEFORE order/limit, chunked at 200, for profiles/app_users/global_community_profiles/vitana_index_scores/relationships/user_interests/memory_facts/user_follows/user_matches; (C) .eq('tenant_id') for column tables. Every ranker (:19-:113), members-directory (:23,:27,:31) and superlatives (:20-:76) function is mapped to M or C by name; no new tenant_id columns on these per-user tables (consistent with R1-F1). Vitest asserts top-N index reads are filled from the active tenant.",
    "deferred_to": null
  }
]
```
