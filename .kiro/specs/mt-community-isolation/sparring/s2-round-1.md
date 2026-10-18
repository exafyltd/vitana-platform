# Sparring round 1 — in_progress

Session: `2d859993-c312-448c-92f4-d1e53f68e147` · plan hash `a3e04bce8c879efd0e1b3f78da3c8f8ec9341ef25199641d16dce1471a029ac3`

## Summary

Eight premises were checked against the pinned commit. Five hold cleanly; two hold only partially; one does not hold. The plan contains two significant false premises, three missing implementation steps, one ambiguous mechanism change, and two minor citation/description issues. None rises to an immediate incident, but three of the majors (F2, F3, F5) could produce silent cross-tenant data exposure or runtime seat-assignment failures if the implementation follows the plan literally.

## Findings

### R1-F1 [major]

`tool_global_search` groups, products, and services lanes are already tenant-scoped. The plan's problem statement lists the entire function as a cross-tenant surface without acknowledging the existing scoping. Only the people, posts, and events lanes lack a tenant filter.

- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/discovery-tools.ts:224` — // Groups — tenant-scoped public groups (mirrors tool_search_community).
    if (id.tenant_id) {
      tasks.push(
        (async () => {
          try {
            const { data } = await repo.searchTenantGroups(sb, id.tenant_id, safe, perCategory);
            found.groups = (data as SearchGroups['groups'] | null) ?? [];
          } catch {
            /* lane is best-effort */
          }
        })(),
      );

      // Products / services catalogs (tenant-scoped tables, VTID-01092).
      tasks.push(
        (async () => {
          try {
            const { data } = await repo.searchTenantProducts(sb, id.tenant_id, query, perCategory);
            found.products = (data as SearchGroups['products'] | null) ?? [];
          } catch {
            /* catalog may not be deployed in this env */
          }
        })(),
      );
      tasks.push(
        (async () => {
          try {
            const { data } = await repo.searchTenantServices(sb, id.tenant_id, query, perCategory);
            found.services = (data as SearchGroups['services'] | null) ?? [];
          } catch {
            /* catalog may not be deployed in this env */
          }
        })(),
      );
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/discovery-tools.ts:166` — // People — public-safe profile columns only (social-memory PROFILE_COLS subset).
    if (excl) {
      const blocked = excl.blocked;
      tasks.push(
        (async () => {
          try {
            const { data } = await repo.searchProfilesByNameOrHandle(sb, safe, perCategory + 5);

Suggestion: Narrow the problem statement to name only the three unscoped lanes (people, posts, events). The `community-scope-gateway` fix list should explicitly state which lanes of `tool_global_search` need the tenant filter added and confirm that the groups/products/services lanes require no change. Without this distinction an implementer may skip the actual missing lanes or add redundant filters that obscure the remaining gap.

### R1-F2 [major]

`fetchUpcomingEvents` has no `tenant_id` parameter in its function signature. Adding a tenant filter requires a breaking signature change that the plan does not name. All callers — including `social-context-builder.ts` and `tool_browse_news_feed` — pass only `limit` today and will need updating.

- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-memory-repository.ts:487` — export async function fetchUpcomingEvents(limit = 40): Promise<RawEvent[]> {
    const supabase = getSupabase();
    if (!supabase) return [];
    const { data } = await supabase
      .from('global_community_events')
      .select('id, title, description, event_type, start_time, location, slug, participant_count')
      .gte('start_time', new Date().toISOString())
      .order('start_time', { ascending: true })
      .limit(limit);
    return (data || []) as RawEvent[];
  }
- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-context-builder.ts:141` — const [candidatePosts, upcomingEvents] = await Promise.all([
      settle(
        'posts',
        fetchCandidatePosts(input.user_id, followingIds, excl, compact ? 25 : 40),
        [],
        degraded,
      ),
      settle('events', fetchUpcomingEvents(compact ? 25 : 40), [], degraded),
    ]);

Suggestion: Add an explicit step to the `community-scope-gateway` lane: add a `tenantId` parameter to `fetchUpcomingEvents`, audit every caller and pass `TenantContext.tenantId`, and confirm no callers outside the community surface need the pre-scoping signature. The same audit is needed for `fetchCandidatePosts` (see F5).

### R1-F3 [major]

The `claim_founding_seat` advisory lock is a single platform-wide key (`hashtext('vtid_04859_founding_1000')`). The plan changes seat numbering to per-tenant but says nothing about the lock strategy. If an implementer naively moves to a per-tenant advisory lock without careful design, or reads 'per-tenant sequence' as a PostgreSQL sequence object requiring its own per-tenant lock, the two mechanisms diverge and concurrent within-tenant signups can race on `max(seat_number) WHERE tenant_id = X`, hitting the new `UNIQUE(tenant_id, seat_number)` constraint with a runtime error. Even if the global lock is kept, it now unnecessarily serialises all tenants' seat assignments — a scaling regression the plan must consciously accept or resolve.

- `exafyltd/vitana-platform:supabase/migrations/20261003100000_vtid_04859_founding_1000.sql:117` — -- One seat at a time, platform-wide.
    PERFORM pg_advisory_xact_lock(hashtext('vtid_04859_founding_1000'));

    -- Re-check under the lock (a concurrent call for the same member).
    SELECT * INTO v_existing FROM public.founding_members WHERE user_id = p_user_id;
    ...
    SELECT COALESCE(max(seat_number), 0) + 1 INTO v_seat FROM public.founding_members;
- `exafyltd/vitana-platform:supabase/migrations/20261003100000_vtid_04859_founding_1000.sql:44` — CREATE TABLE IF NOT EXISTS public.founding_members (
    user_id        uuid PRIMARY KEY,
    tenant_id      uuid NOT NULL,
    seat_number    integer NOT NULL UNIQUE CHECK (seat_number BETWEEN 1 AND 1000),

Suggestion: In the `founding-pool-tenant-db` lane explicitly specify the advisory lock strategy: either keep the global lock (accepting cross-tenant serialisation and documenting it) or change to a per-tenant key such as `hashtext('vtid_04859_founding_1000_' || p_tenant_id::text)`. Document the choice and the pgTAP test that proves concurrent same-tenant calls do not produce a UNIQUE violation.

### R1-F4 [major]

`resolve_recipient_candidates` appears to already be scoped to the actor's tenant at the DB-RPC layer. The route header says 'peer-scoped to the actor's tenant'; the repository passes `p_global: false` which is the community-scope switch. The plan lists this endpoint as a cross-tenant surface requiring a community-scope fix without verifying what `p_global: false` actually enforces, risking either redundant code or a false assurance that the endpoint is unscoped.

- `exafyltd/vitana-platform:services/gateway/src/routes/users-resolve.ts:1` — /**
 * VTID-01967: POST /api/v1/users/resolve
 *
 * Voice-resolver primitive. Given a spoken-name token, returns ranked
 * candidates from `resolve_recipient_candidates()` (peer-scoped to the
 * actor's tenant). The ORB voice tool `resolve_recipient` calls this; the
 * frontend MessageComposeModal also uses it as a typeahead source.
 */
- `exafyltd/vitana-platform:services/gateway/src/routes/users-resolve-repository.ts:17` — export async function resolveRecipientCandidates(
    sb: SupabaseClient,
    actorUserId: string,
    token: string,
    limit: number,
  ) {
    return sb.rpc('resolve_recipient_candidates', {
      p_actor: actorUserId,
      p_token: token,
      p_limit: limit,
      p_global: false,
    });
  }

Suggestion: Before coding the gateway change for `resolve_recipient_candidates`, read the `resolve_recipient_candidates` DB function definition and confirm whether `p_global: false` already restricts results to the actor's tenant. If it does, the component should be removed from the `community-scope-gateway` lane to avoid a redundant layer. If the RPC is not yet tenant-scoped, the plan must state whether the fix is in the DB function or in the gateway wrapper.

### R1-F5 [major]

`fetchCandidatePosts` reads `profile_posts` with no tenant filter. It is called from `social-context-builder.ts` (the social-memory resolver path the plan names as a fix site) and also from `tool_browse_news_feed`. Neither call site passes a `tenant_id` today. The plan's `community-tenant-db` lane adds `tenant_id` to `profile_posts`, but the `community-scope-gateway` lane fix list does not explicitly name `fetchCandidatePosts` or the `profile_posts` reads, risking this call site being overlooked.

- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-memory-repository.ts:420` — export async function fetchCandidatePosts(
    userId: string,
    followedIds: string[],
    excl: { blocked: Set<string>; muted: Set<string>; hidden_posts: Set<string> },
    limitPerSource = 40,
  ): Promise<RawPost[]> {
    ...
    const queries: PromiseLike<any>[] = [
      supabase
        .from('profile_posts')
        .select(baseSelect)
        .eq('is_public', true)
        .neq('moderation_status', 'rejected')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(limitPerSource),
- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-context-builder.ts:141` — settle(
        'posts',
        fetchCandidatePosts(input.user_id, followingIds, excl, compact ? 25 : 40),
        [],
        degraded,
      ),

Suggestion: Add `fetchCandidatePosts` and its `profile_posts` reads explicitly to the `community-scope-gateway` fix list. Both its callers (`buildSocialContextPack` and `tool_browse_news_feed`) must be updated to pass `tenantId`; the function signature must gain a `tenantId` parameter. Include a Vitest test that the social context post feed and the news feed voice tool return only the active tenant's posts when the flag is on.

### R1-F6 [major]

The plan identifies `community_groups` and `community_group_members` (without the `global_` prefix) as tables used by the community-member-ranker. These differ from `global_community_groups` and `global_community_group_members` targeted by `community-tenant-db`. If they are distinct tables, the ranker's group queries would remain unscoped after the spec completes.

- `exafyltd/vitana-platform:services/gateway/src/services/voice-tools/community-member-ranker-repository.ts:87` — export async function searchGroupsByTopicOrName(sb: SupabaseClient, kwLike: string) {
    return sb.from('community_groups').select('id, name, topic_key').or(`topic_key.ilike.${kwLike},name.ilike.${kwLike}`).limit(20);
  }
  ...
  export async function fetchGroupMembersByGroupIds(sb: SupabaseClient, groupIds: string[]) {
    return sb.from('community_group_members').select('user_id, group_id').in('group_id', groupIds).limit(500);
  }
- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-memory-repository.ts:539` — export async function fetchGroupsForUsers(userIds: string[]): Promise<Map<string, Set<string>>> {
    ...
    const { data } = await supabase
      .from('global_community_group_members')
      .select('group_id, user_id')

Suggestion: Verify whether `community_groups`/`community_group_members` and `global_community_groups`/`global_community_group_members` are the same tables or distinct. If distinct, add the non-`global_` tables to the `community-tenant-db` lane (column add + RLS) and to the `community-scope-gateway` fix list for the ranker.

### R1-F7 [minor]

The plan cites founding migration line 60 as part of the `claim_founding_seat` function context, but line 60 is the `CREATE POLICY founding_members_select_own` RLS policy, not the function. The function starts at line 66; tenant resolution from `user_tenants` runs at lines 107–115, not 99–112.

- `exafyltd/vitana-platform:supabase/migrations/20261003100000_vtid_04859_founding_1000.sql:58` — DROP POLICY IF EXISTS founding_members_select_own ON public.founding_members;
    CREATE POLICY founding_members_select_own ON public.founding_members
      FOR SELECT USING (auth.uid() = user_id);
    REVOKE ALL ON public.founding_members FROM anon, authenticated;
    GRANT SELECT ON public.founding_members TO authenticated;
    GRANT ALL ON public.founding_members TO service_role;
    
    -- 2. claim_founding_seat -------
    CREATE OR REPLACE FUNCTION public.claim_founding_seat(
- `exafyltd/vitana-platform:supabase/migrations/20261003100000_vtid_04859_founding_1000.sql:107` — IF v_tenant_id IS NULL THEN
      SELECT tenant_id INTO v_tenant_id
      FROM public.user_tenants
      WHERE user_id = p_user_id AND is_primary = true
      LIMIT 1;
    END IF;
    IF v_tenant_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'NO_TENANT');
    END IF;

Suggestion: Correct the citation to `:66,107-115`. Low impact, but implementers using the line references as a starting point for the migration edit will land in the wrong place.

### R1-F8 [minor]

The `community-scope-gateway` fix for the social-memory resolver is described as 'take the active tenant from `TenantContext`, never a tool argument'. But `social-context-builder.ts` already takes `input.tenant_id` from `AssistantSocialContextInput.tenant_id` (the session JWT), and `social-memory-service.ts` already passes the session `tenant_id` through. The source is effectively the same as `TenantContext.tenantId`. The actual fix needed is WS1's membership verification, not a source swap. An implementer following the plan literally could perform a no-op rename and mark the item complete.

- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-memory-service.ts:26` — export interface AssistantSocialContextInput {
    tenant_id: string;
    user_id: string;
    question: string;
    ...
- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-context-builder.ts:92` — settle(
        'messages',
        fetchRecentMessageContacts(input.user_id, input.tenant_id, excl.blocked, compact ? 8 : 15),
        [],
        degraded,
      ),
      settle('group_chats', fetchGroupChats(input.user_id, input.tenant_id), [], degraded),

Suggestion: Restate the social-memory resolver fix as: 'verify that `input.tenant_id` is an active membership via WS1's `is_member()` before passing it to repository reads; do not accept a caller-supplied override that bypasses this check.' This makes the acceptance criterion concrete and testable rather than a source-swap that changes nothing.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
