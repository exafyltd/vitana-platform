# Sparring round 2 — in_progress

Session: `e768aae5-43ac-4bc7-9426-703e913aa5f2` · plan hash `5aaaf38e432d5c7f31ab2e91d57826a71d76e068a135ef7a2e44574284c1c2c6`

## Summary

All four R1 findings were accepted and the revised plan addresses each one correctly in the text. No rejected/deferred findings to dispute. One new major finding: the plan's gateway-lane enumeration misses `community-activity-builder-repository.ts`, a separate data-access seam with five direct community-table queries that bypass the scoped `social-memory-repository.ts` functions.

## Findings

### R2-F1 [major]

`community-activity-builder-repository.ts` is a separate data-access seam with five functions that directly query community tables (`profile_posts`, `global_event_participants`, `global_community_group_members`, `global_community_groups`). The plan's gateway lane (`community-scope-gateway`) enumerates scoping for `social-memory-repository.ts`, `community-member-ranker-repository.ts`, `community-members-repository.ts`, `superlatives-repository.ts`, `discovery-tools.ts`, and `connect-people-repository.ts`, but `community-activity-builder-repository.ts` is never mentioned. Its queries are called by `community-activity-builder.ts` (listed only as an *importer* of the social-memory-repository, at :107) — but the five repository functions it delegates to are in a different file and do not go through the scoped social-memory-repository path. Specifically: `fetchNetworkVisiblePosts` (:45, queries `profile_posts`), `fetchNetworkEventParticipations` (:57, queries `global_event_participants`), `fetchPersonEventParticipations` (:21, queries `global_event_participants`), `fetchPersonGroupJoins` (:31, queries `global_community_group_members`), and `fetchCommunityGroupNames` (:41, queries `global_community_groups`). These are unscoped community reads on the exact tables the plan is trying to tenant-isolate. Cross-tenant posts, event participations, and group joins would leak through `buildPersonActivity` and `buildNetworkDigest`.

- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/community-activity-builder-repository.ts:1` — export async function fetchNetworkVisiblePosts(sb: SupabaseClient, userIds: string[], since: string, limit: number) {
    return sb
      .from('profile_posts')
      .select('id, user_id, content, created_at')
      .in('user_id', userIds)
      .eq('is_public', true)
      .neq('moderation_status', 'rejected')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit);
}

export async function fetchNetworkEventParticipations(sb: SupabaseClient, userIds: string[], since: string, limit: number) {
    return sb
      .from('global_event_participants')
      .select('event_id, user_id, registered_at')
- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/community-activity-builder.ts:14` — import {
    fetchPersonById,
    fetchPersonPosts,
    fetchPeople,
    fetchEventTitles,
  } from './social-memory-repository';
import * as repo from './community-activity-builder-repository';
- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/community-activity-builder.ts:97` —       const [posts, participations] = await Promise.all([
        repo.fetchNetworkVisiblePosts(supabase, ids, since, 15),
        repo.fetchNetworkEventParticipations(supabase, ids, since, 15),
      ]);

      const authorIds = new Set<string>([
        ...(posts.data || []).map((p) => p.user_id),
        ...(participations.data || []).map((p) => p.user_id),
      ]);
      const people = await fetchPeople(Array.from(authorIds));

Suggestion: Add `community-activity-builder-repository.ts` to the gateway lane's enumeration. Each of its five functions needs tenant scoping: `fetchNetworkVisiblePosts` and `fetchCommunityGroupNames` on class (i) tables → (C) `.eq('tenant_id', tenantId)` once the column exists; `fetchPersonEventParticipations`, `fetchNetworkEventParticipations`, and `fetchPersonGroupJoins` → (M) `.in('user_id', memberIds)` or pre-scoped via event_id/group_id join. The parent `buildPersonActivity` and `buildNetworkDigest` must accept and thread `tenantId`. Also classify `global_event_participants` (used by these queries and by `fetchEventParticipants`/`fetchEventsForUsers` in social-memory-repository.ts) into one of the three DB-lane classes so it gets an RLS policy rewrite.

### R2-F2 [minor]

`global_event_participants` is queried by at least four functions across two repositories (`social-memory-repository.ts:506,521` and `community-activity-builder-repository.ts:21,57`) but is not classified in the DB lane's table taxonomy (class (i) content, (ii) child, or (iii) per-user). It therefore receives no `tenant_id` column, no RLS policy rewrite, and no realtime tenant predicate. If this table is realtime-reachable, the plan's stated check ('confirm RLS on each realtime-reachable table') would not cover it.

- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-memory-repository.ts:500` — export async function fetchEventParticipants(
    eventIds: string[],
  ): Promise<Map<string, string[]>> {
    ...
    const { data } = await supabase
      .from('global_event_participants')
      .select('event_id, user_id, status')
      .in('event_id', eventIds.slice(0, 60))
      .limit(3000);
- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/community-activity-builder-repository.ts:21` — export async function fetchPersonEventParticipations(sb: SupabaseClient, personId: string, since: string, limit: number) {
    return sb
      .from('global_event_participants')
      .select('event_id, registered_at')
      .eq('user_id', personId)
      .gte('registered_at', since)
      .order('registered_at', { ascending: false })
      .limit(limit);
  }

Suggestion: Classify `global_event_participants` as class (ii) (child of `global_community_events`, copy `tenant_id` from parent by `event_id` join, same pattern as `global_community_group_members`) and add it to the DB lane's column-add, backfill, RLS rewrite, and realtime check.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
