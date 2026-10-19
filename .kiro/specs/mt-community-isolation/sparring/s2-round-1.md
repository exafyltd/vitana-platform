# Sparring round 1 — in_progress

Session: `ed136e24-677b-483e-92ea-78045c7b4748` · plan hash `f2f50e7e8e3cf5fc1b07a8a8f220cfbda98dd2d3eb0cff4c1100cc11b87647e4`

## Summary

The plan is well-researched and most premises are accurately cited and verified against the pinned code (ranker pool, members directory, superlatives, discovery-tools lanes, social-memory unfiltered reads, founding migration line numbers, billing repository, resolve_recipient_candidates p_global=false, community_groups RLS). Two problem areas undermine it. First, the DB lane proposes adding a single `tenant_id` column to per-user tables (`global_community_profiles`, plus backfilling by membership join) and then scoping by it — but a per-user row cannot represent multi-tenant membership, so the 1:N user_tenants backfill is non-deterministic and would permanently hide a member from tenants they belong to once scoped. Second, the code-lane fix enumerates only two of the many unfiltered cross-tenant reads in the social-memory path (`fetchCandidatePosts`/`fetchUpcomingEvents`), leaving `fetchPeople`, `fetchGroupsForUsers`, `resolvePersonByName`, `fetchPersonPosts`, `fetchEventParticipants`, `fetchEventsForUsers` and others leaking cross-tenant once the RLS policy rewrite (which is NOT flag-gated) is applied over service-role/RLS-bypassed clients. Also, the scoping mechanism for community readers whose underlying tables (`profiles`, `app_users`, `vitana_index_scores`, `relationships`) receive no `tenant_id` column is under-specified.

## Findings

### R1-F1 [blocker]

Adding a single `tenant_id` column to per-user community tables (`global_community_profiles`, and backfilling `profile_posts`/`global_community_*` by membership join) cannot represent multi-tenant membership. `global_community_profiles` is one row per user (keyed by `user_id`, selected as `.select('user_id').eq('is_visible', ...)`), while a user may hold memberships in multiple tenants via `user_tenants` (1:N). A membership-join backfill of a single `tenant_id uuid` column is therefore non-deterministic (which membership row wins?) and, once the reader is scoped `.eq('tenant_id', activeTenant)`, a member with two memberships would be permanently invisible to the tenant not chosen by the backfill — a tenant-isolation correctness defect, not just a scaling concern.

- `exafyltd/vitana-platform:services/gateway/src/services/voice-tools/community-member-ranker-repository.ts:19` — export async function fetchVisibleProfileUserIds(sb: SupabaseClient) {
  return sb.from('global_community_profiles').select('user_id').eq('is_visible', true);
}
- `exafyltd/vitana-platform:supabase/migrations/20261003100000_vtid_04859_founding_1000.sql:107` — IF v_tenant_id IS NULL THEN
  SELECT tenant_id INTO v_tenant_id
  FROM public.user_tenants
  WHERE user_id = p_user_id AND is_primary = true
  LIMIT 1;

Suggestion: Do not scope per-user tables by a single `tenant_id` column. For `global_community_profiles` (and any per-user visibility/identity data) resolve scope via a membership predicate (EXISTS over `user_tenants`/`is_member()`) at read time, not a backfilled column. Only add `tenant_id` to tables whose rows are genuinely tenant-scoped content (posts, events, media, streams) where the creating tenant is unambiguous. If a `tenant_id` column on per-user tables is still required, the plan must specify a deterministic/multi-valued mapping (e.g. a join table or a row per membership), not a single-column backfill.

### R1-F2 [major]

The code-lane fix (`community-scope-gateway`) enumerates only `fetchCandidatePosts` and `fetchUpcomingEvents` as the unfiltered social-memory reads to be tenant-scoped, but the social-memory path performs many additional cross-tenant reads with no `tenant_id` predicate. These would continue to leak cross-tenant content once the non-flag-gated RLS rewrite is live (service-role/RLS-bypassed clients are not protected by RLS) and the per-tenant flag flips on.

- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-memory-repository.ts:539` — export async function fetchGroupsForUsers(userIds: string[]): Promise<Map<string, Set<string>>> {
  ...
      .from('global_community_group_members')
      .select('group_id, user_id')
      .in('user_id', userIds.slice(0, 50))
- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-memory-repository.ts:649` — export async function resolvePersonByName(hint: string): Promise<SocialPerson | null> {
  ...
      .from('profiles')
      .select(`${PROFILE_COLS}, full_name`)
      .or(`display_name.ilike.%${term}%,full_name.ilike.%${term}%,handle.ilike.%${term}%,vitana_id.ilike.%${term}%`)
      .limit(5);
- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-memory-repository.ts:72` — export async function fetchPeople(userIds: string[]): Promise<Map<string, SocialPerson>> {
  ...
  const { data, error } = await supabase.from('profiles').select(PROFILE_COLS).in('user_id', ids.slice(0, 200));

Suggestion: Enumerate the complete set of unfiltered social-memory readers (fetchPeople, fetchFollowEdges, fetchExclusions, fetchGroupsForUsers, fetchGroupNames, fetchEventTitles, fetchEventParticipants, fetchEventsForUsers, fetchInterests, resolvePersonByName, fetchPersonPosts) and either thread tenant scope through each or explicitly document them as out of scope with an owner decision. Otherwise the community isolation suite will fail in staging once the flag is on.

### R1-F3 [major]

The scoping mechanism for community readers whose backing tables receive no `tenant_id` column is under-specified. The superlatives, members directory, and ranker hydrate from `profiles`, `app_users`, `vitana_index_scores`, and `relationships` — none of which are in the `community-tenant-db` list of tables getting a `tenant_id` column (`profile_posts`, `global_community_*`, `media_uploads`, `community_live_streams`, `calendar_events`, `content_reports`, `feedback_tickets`). The plan says to scope 'by membership join' but never states where the join is applied (which repository function, which table, what predicate), leaving an implementer without a concrete plan for the very tables these readers depend on.

- `exafyltd/vitana-platform:services/gateway/src/services/voice-tools/superlatives-repository.ts:35` — export async function fetchTopVitanaIndexScores(sb: SupabaseClient, limit: number) {
  return sb
    .from('vitana_index_scores')
    .select('user_id, score_total, date')
    .order('score_total', { ascending: false })
- `exafyltd/vitana-platform:services/gateway/src/routes/community-members-repository.ts:27` — export async function countProfilesExcludingSelf(sb: SupabaseClient, selfUserId: string) {
  return sb.from('profiles').select('user_id', { count: 'exact', head: true }).neq('user_id', selfUserId);
}

Suggestion: Specify, per reader, the exact table and predicate for the membership-join scope (e.g. join `user_tenants`/`is_member(tenant_id)` to filter `user_id`s before hydrating). If `vitana_index_scores`/`relationships`/`app_users` must themselves be scoped, either add a tenant-derived scope to those reads or add a `tenant_id` (membership-derived) column to the affected tables and list them in `community-tenant-db`.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
