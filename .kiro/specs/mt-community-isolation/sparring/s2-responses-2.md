# Round 2 responses (session ed136e24-677b-483e-92ea-78045c7b4748)
```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Verified connect-people-repository.ts: countTodaysUnviewedMatches :77, fetchTopMatch :86, fetchMatchById :96, fetchReciprocalAcceptedMatch :100 read daily_matches with no tenant predicate; the handlers already hold ctx.tenantId (connect-people.ts:108). Plan Fix (f) replaces the generic 'connect-people -> (M)' with a per-reader list: the four daily_matches readers are (C) .eq('tenant_id', tenantId) since daily_matches is a class (i) content table (legacy NULL-tenant matches are not surfaced with the flag on); user_interests (:112,:116), app_users (:122,:126) and fetchGroupMembersAmong (:198) are (M); fetchPrimaryTenantUsers, fetchNotificationPrefs, relationship_edges reads, countMessagesBetween and fetchPeerOpportunities are already .eq('tenant_id'); fetchGroupRecommendations (:186) is viewer-own. Tests and tasks G1/G5 add a Jest case asserting the daily-match deliver/nudge/mutual-accept introduction paths surface only same-tenant matched_user_ids.",
    "deferred_to": null
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Verified fetchPeople (:72, .in('user_id', ids.slice(0,200)) at :78) is called internally at :151, :231, :287, :354, :680 and externally at discovery-tools.ts:195,:368, community-activity-builder.ts:107, social-context-builder.ts:161, social-read-tools.ts:132. Plan Fix (e) now defines the contract fetchPeople(userIds, scope?: { memberIds: Set<string> }) that intersects ids before the .in(...); memberIds is resolved once per request and passed explicitly from fetchFollowEdges, fetchMatches, fetchPersonById/resolvePersonByName and the four external non-chat sites. The chat-derived hydrations (fetchRecentMessageContacts :287, fetchUnreadMessageSummary :354, social-read-tools.ts:132) call it without scope, deterministic and unchanged, because their peer ids come from chat rows already .eq('tenant_id'). Tasks G2/G5 mirror this with a Jest case per call site.",
    "deferred_to": null
  }
]
```
