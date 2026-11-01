---
change_class: standard
---
# Community isolation (WS3 Community part) — tenant_id + RLS + tenant-scoped reads
<!-- plan:begin -->
## Re-plan answers (session `ed136e24` round 3)
Re-plan of `mt-community-isolation` (branch `kiro/mt-community-isolation/plan`; PLAN-SPAR session `ed136e24`
escalated at the round cap). Every premise was re-verified on platform `origin/main` `62990ce285` and vitana-v1
`origin/main` `58c76c956` on 2026-11-01; corrected line numbers are used below.
- **R3-F1** (`resolvePersonByName` does not go through `fetchPersonById`): accepted. The plan's earlier claim was
  wrong. `resolvePersonByName` (`social-memory-repository.ts:649-676`) runs its own fuzzy `.or(…)` query on
  `profiles` with `.limit(5)` (`:655-659`) and calls `mapPerson(best)` directly. Fix (e) now scopes that query itself:
  - With the flag on, it takes `scope: { memberIds }` and adds `.in('user_id', memberIds)` to the same query
    **before** `.limit(5)`. The member ids are chunked at 200 like `fetchPeople`; each chunk runs the same query, and
    the hits are merged before `best` is chosen. A name search therefore never returns a member of another tenant,
    and the top 5 are not starved.
  - The function also gains a `tenantId` parameter. Its three callers pass the verified active tenant:
    `intent-find-match.ts:277` (`id.tenant_id`), `orb-tools/p0-gap-tools.ts:71` (`resolveMember`, which now receives
    `id` from `tool_follow_member` `:90`, `tool_unfollow_member` `:127` and `resolveAuthorPost` `:488`), and
    `person-context-builder.ts:52` (`BuildPersonContextInput.tenant_id`, `:31`).
  - While touching this query, the lane also strips the PostgREST `.or()` reserved characters `,()*:."\` from the
    term. Today only `%` and `_` are stripped (`:652`), so a hint containing a comma can add filter clauses.
  - Test: with the flag on, a name that matches one member of tenant A and one of tenant B returns only the
    tenant-A member for a tenant-A viewer. A hint containing `,` or `)` adds no clause. Both are red on
    `origin/main`.
- **R3-F2** (no predicate for `user_matches`' two-column OR): accepted. `user_id_1`/`user_id_2` are added to the (M)
  enumeration, and the rule is fixed: the viewer's own column is fixed and the **other** column must be in
  `memberIds`.
  - `fetchMatches` (`:169`) replaces the single `.or('user_id_1.eq.<viewer>,user_id_2.eq.<viewer>')` (`:187`) with
    two queries per 200-id chunk: `.eq('user_id_1', viewer).in('user_id_2', chunk)` and
    `.eq('user_id_2', viewer).in('user_id_1', chunk)`. Each keeps `.order('matched_at', desc).limit(limit)`; the
    results are merged, re-sorted by `matched_at` and cut to `limit`.
  - The `daily_matches` half of `fetchMatches` (`:178-183`) uses (C) `.eq('tenant_id', tenantId)`.
  - Test: a mutual match whose counterpart is in another tenant is not returned, whichever column holds the viewer.
    A same-tenant counterpart is returned from both column orders.
- **Line corrections from the re-verification:**
  - `founding_members.tenant_id NOT NULL` is at `:45`, and the advisory lock is at `:118`.
  - The `discovery-tools.ts` posts lane is at `:188` (`fetchPeople` at `:195`), and the events lane is at `:216`.
  - `p_global: false` is at `users-resolve-repository.ts:28`.
  - `social-context-builder.ts` passes `input.tenant_id` at `:92` and `:96`.
  - The superlatives repository is `services/voice-tools/superlatives-repository.ts`.
  - None of the class (i)/(ii) content tables has a `tenant_id` column today, and no migration in either repo adds
    one.
  - `platform_only_accounts` exists only in docs.
  - No `community_scope` flag key exists yet.
- **Migration versions:** `20261101110000`/`110100` (mt-launch) are now on `main`, so the `20261101` slots this plan
  held would apply out of timestamp order (`collaboration.md` §7d). Every multi-tenant re-plan shifts its reserved
  slots by one day and keeps the time slot: `20261101HHMMSS` → `20261102HHMMSS`. That keeps the cross-spec C3/O4
  order: this spec's `20261102060000`–`065959`, the pinned `platform_only_accounts` at `20261102070160`, and
  mt-tenant-admin's `moderator-tenant-scope-db` at `20261102070600`, after it. The `20261102*` range is free.
- **WS1 dependency named:** the resolver owner is spec `mt-identity-r2`. The lanes `helpers-and-policy-rewrite`
  (`tenant_id_for_policies()`, `is_member()`) and `membership-unification` must be `done` and applied before this
  spec's policy rewrite is applied. This is an external dependency, recorded in each DB lane, because `depends_on`
  names lanes of this plan only.
- **Lanes on today's rules:** every lane is `executor: kiro`, `next_actor: kiro`, `reviewer_seat:
  agent:vitana-lane-reviewer`. No lane touches a governance path. `community-scope-gateway`'s test scope is narrowed
  from `services/gateway/test/**` to `services/gateway/test/mt-community-*.test.ts`. `docs/multitenancy/MIGRATION-QUEUE.md`
  is a hot file shared by the three DB lanes, so they land one after another (`community-tenant-db` →
  `founding-pool-tenant-db` → `platform-only-accounts-db`), each rebased on the previous one. Migrations are applied
  by Kiro through `RUN-MIGRATION.yml` only after the owner approves the files and the target database (§7d).

## Problem
Scope = the WS3 **Community** half of the program plan §4.11 / §6 (the Network layer — `scope`
columns on `chat_messages`/`daily_matches`/offerings, `network_visible`, the `send_message*`
rewrite, Network groups — is a sibling spec, out of scope here). Verified read-only in code
2026-10-17 and re-verified 2026-11-01 against platform `62990ce285` and vitana-v1 `58c76c956`.
1. **Some community reads are network-wide, not tenant-scoped — but not all are.** Unscoped (visibility +
   rule-45 exclusion only, no viewer-tenant filter): `find_community_member`'s pool
   (`services/gateway/src/services/voice-tools/community-member-ranker-repository.ts:20`), the members
   directory (`routes/community-members-repository.ts:24`), superlatives
   (`services/voice-tools/superlatives.ts`+repo), `connect-people`, and in `tool_global_search`
   (`services/orb-tools/discovery-tools.ts`) **only** the people (`:172`), posts (`:188`) and events
   (`:216 searchUpcomingEventsForGlobalSearch`) lanes. Already tenant-scoped (no change): `global_search`'s
   groups/products/services lanes (gated on `id.tenant_id`, `:225+`) and `resolve_recipient_candidates`
   (`users-resolve-repository.ts:28` passes `p_global:false`; the RPC resolves the actor's tenant and
   `p_global DEFAULT false` restricts to it,
   `supabase/migrations/20260812140200_VTID_03623_resolver_drift_fix_chat_peer_flag.sql`).
2. **`daily_matches` candidate pool is cross-tenant.** The visible pool is read from `profiles`
   filtered only by `global_community_profiles.is_visible = true`
   (`vitana-v1/supabase/functions/generate-daily-matches/index.ts:99-113`), then a by-id profile
   fetch at `:166-169`; no tenant/scope predicate anywhere, and the `daily_matches` table has no
   `tenant_id`/`scope` column.
3. **Social-memory resolver passes an UNVERIFIED session `tenant_id` into reads.**
   `social-memory-service.ts` (`AssistantSocialContextInput.tenant_id`, :26), `social-context-builder.ts`
   (:92,:141) pass `input.tenant_id` (the session JWT's active tenant, not a tool arg) into
   `social-memory-repository.ts` reads (`.eq('tenant_id', tenantId)` at :259,:337,:378,:612,:710). The gap
   is that the value is **not checked against an active membership**. Two reads in that path have NO tenant
   filter at all: `fetchCandidatePosts` on `profile_posts` (:420, no `tenantId` param) and
   `fetchUpcomingEvents` on `global_community_events` (:487, `fetchUpcomingEvents(limit = 40)`).
4. **Community content tables have tenant-unaware RLS, not none.** The four `global_community_*` tables
   (`_profiles`, `_groups`, `_events`, `_group_members`) + `content_reports` already have RLS **enabled**
   with permissive policies (`vitana-v1/.../20250917153624_*.sql`, `.../20251010065205_*.sql`), so this
   spec **rewrites existing live policies**, it does not newly enable RLS. `profiles.tenant_id` is NULL
   for all 236 members (WS2 backfills it), so scope by a **membership join** (`user_tenants`), not by
   `profiles.tenant_id`. **Per-user rows cannot carry one tenant:** `global_community_profiles` is one row
   per user (`user_id UUID NOT NULL UNIQUE`, `vitana-v1/.../20250917153624_*.sql:7`) while `user_tenants`
   is 1:N (`UNIQUE (tenant_id, user_id)`, `20251231000000_vtid_01101_phase_a_bootstrap.sql:89-98`, and
   `is_primary` has no uniqueness constraint), so a single backfilled `tenant_id` on a per-user table is
   non-deterministic and would hide a multi-tenant member from every tenant but one.
5. **Founding pool cap and seat numbering are global, not per tenant.** `founding_members` ALREADY has
   `tenant_id uuid NOT NULL` (populated) and `claim_founding_seat(p_user_id, p_tenant_id)` resolves the
   tenant from `user_tenants` (`supabase/migrations/20261003100000_vtid_04859_founding_1000.sql:45,66,107-113`;
   `:60` is the RLS policy, not the function). Still global: `v_max_seats := 1000` (`:76`),
   `max(seat_number)+1` table-wide (`:131`), the global `UNIQUE CHECK (seat_number BETWEEN 1 AND 1000)`
   (`:46`), the platform-wide advisory lock (`:118`), and gateway reporting
   (`routes/billing-repository.ts:141,143`). D10 wants per-tenant pools — the gap is per-tenant cap +
   seat allocation + lock, **not** a column add or backfill.
6. **Test/service account rules are platform-wide, not per tenant** (rule 43-45 sets:
   `service_bot_accounts`, `notification_test_actors`). There is no `platform_only_accounts` view
   (cross-spec O5 — this spec M2 creates it).
7. **Realtime community subscriptions carry no tenant predicate** (program plan §2/§3-S-J:
   realtime-reachable tables without tenant RLS leak once `current_tenant_id()` resolves).
8. **The ranker's `community_groups`/`community_group_members` are DISTINCT from the `global_community_*`
   tables.** `community-member-ranker-repository.ts:89,93` reads VTID-01084 `community_groups` (which ALREADY
   has `tenant_id NOT NULL` + tenant-aware RLS,
   `supabase/migrations/20251231100000_vtid_01084_community_personalization_v1.sql:35,133,146-147`) and
   `community_group_members` (no migration in tree; best-effort read). So neither is a column/RLS target of
   `community-tenant-db`; the fix is the ranker query *applying* the existing tenant scope — owned by
   `community-scope-gateway`.
## Fix (per lane)
Dependency: WS1 (identity/resolver — `tenant_id_for_policies()`, `is_member(tenant_id)`,
`TenantContext`, membership canonicalisation) ships the resolver this spec's RLS and read filters
call. This spec is **dark by default** (`tenant_settings.feature_flags.mt.community_scope`) and its
read-path filters are no-ops until WS1's resolver is live; the migrations expand-only so they are
safe to apply ahead of activation. DB lanes are split from code lanes (§4.7).
- **Lane `community-tenant-db` (DB, platform).** Tables split into three classes:
  (i) **tenant-scoped content** — `profile_posts`, `global_community_groups`, `global_community_events`,
  `media_uploads`, `community_live_streams`, `calendar_events`, `content_reports`, `feedback_tickets`,
  `daily_matches`: add `tenant_id` (nullable → BEFORE INSERT trigger fills the writer's ACTIVE tenant →
  deterministic backfill → `CHECK NOT VALID` → VALIDATE; **no `SET NOT NULL`** — WS2). Backfill rule:
  the author's membership if they hold exactly one; else their single `is_primary` membership; else
  **leave NULL** (no guess) — a read-only pre-check counts the ambiguous rows, the NULL rows stay
  author-only readable (Rollout) and WS2 resolves them; the `CHECK` is therefore added `NOT VALID` and
  VALIDATEd only when that count is 0. (ii) **child rows** — `global_community_group_members`: `tenant_id`
  is copied from its parent `global_community_groups.tenant_id` (trigger + backfill by `group_id`
  join; deterministic). (iii) **per-user rows** — `global_community_profiles`: **NO `tenant_id` column**;
  its RLS and every reader scope by a membership predicate at read time (`EXISTS (SELECT 1 FROM
  user_tenants ut WHERE ut.user_id = <row>.user_id AND ut.tenant_id = <active tenant>)`), so a member
  of two tenants is visible in both. **Rewrite** the existing RLS policies classified user-private /
  tenant-shared (`is_member`) / admin-only (`is_tenant_admin`); confirm RLS on each realtime-reachable
  table; add the realtime tenant predicate. The policy rewrite is not flag-gated and is QUEUE-sequenced
  per Rollout. For `content_reports` this spec owns only `tenant_id` + base RLS; mt-tenant-admin's
  `moderator-tenant-scope-db` (`070600`, sorts after) layers moderation policies on top (cross-spec O4).
  Expand/contract, `lock_timeout` + retries, `bak_*` snapshot before data moves, rollback migration,
  read-only pre/post checks, MIGRATION-QUEUE rows at the stated position.
- **Lane `founding-pool-tenant-db` (DB, platform).** `tenant_id` + `claim_founding_seat(p_user_id,
  p_tenant_id)` already exist (VTID-04859) → **no column add, no backfill** (verify populated). Change:
  per-tenant seat allocation (`max(seat_number)+1 WHERE tenant_id = p_tenant_id`, replacing `:131`),
  per-tenant `UNIQUE (tenant_id, seat_number)` + cap check (replacing the global `:46`), per-tenant
  `v_max_seats` (`:76`), and a **per-tenant advisory lock** `hashtext('vtid_04859_founding_1000_' ||
  p_tenant_id::text)` replacing the platform-wide one (`:118`) — the global key serialises all tenants
  (scaling regression), dropping the lock races same-tenant calls into the new UNIQUE. "Per-tenant
  sequence" = this per-tenant max+lock, not a Postgres `SEQUENCE`. `countFoundingSeats` scoping is in
  the code lane. Expand/contract on the constraint swap; snapshot + rollback migration. Separate DB lane
  (independent table + RPC, own queue row).
- **Lane `platform-only-accounts-db` (DB, platform) — M2, cross-spec O5.** Create the
  `platform_only_accounts` view (members of the platform tenant `is_platform=true` with no community
  membership) and add it to the rule-45 exclusion lint alongside `service_bot_accounts` /
  `notification_test_actors`. This spec's **C3 migration is version `20261102070160`** (day-shifted from `20261101070160`, Re-plan answers) (reserved
  inside spec 07's gap — cross-spec C3; keep exactly). pgTAP: a platform-only account never appears
  in any community surface.
- **Lane `community-scope-gateway` (CODE, platform, dark).** Behind `feature_flags.mt.community_scope`,
  thread the viewer's ACTIVE tenant (WS1 `TenantContext.tenantId`) into exactly these readers.
  **Two scope mechanisms, nothing else:** (M) *member-id scope* for per-user tables that get no
  `tenant_id` (`profiles`, `app_users`, `global_community_profiles`, `vitana_index_scores`,
  `relationships`, `user_interests`, `memory_facts`, `user_follows`, `user_matches`): one new helper
  `fetchActiveTenantMemberIds(sb, tenantId)` in `community-members-repository.ts` (`user_tenants.user_id
  WHERE tenant_id = $1`, once per request) and each read adds `.in('user_id' | 'to_user_id' |
  'followee_id' | 'following_id' | 'follower_id', memberIds)` — and for the two-column `user_matches` the viewer's column is fixed and the OTHER column (`user_id_2` / `user_id_1`) takes `.in(…, memberIds)` in two queries per chunk (R3-F2) **before** ordering/limit (so top-N reads
  are not starved), chunked at 200 ids like the existing `fetchPeople` slice (`:78`) — each chunk keeps
  the same order/limit/cursor and the results are merged, re-sorted and cut to N (counts summed); by-id hydration
  intersects its id list with `memberIds`. (C) *column scope* `.eq('tenant_id', tenantId)` for the
  content tables that get the column (`profile_posts`, `global_community_groups`/`_events`/
  `_group_members`, `daily_matches`) and `community_groups` (column exists). Per reader:
  (a) ranker (`community-member-ranker-repository.ts`): `fetchVisibleProfileUserIds` (`:19`),
  `fetchProfilesByIds`, the three `profiles.service_offerings` searches, `fetchUsersByIds`,
  `searchBioByKeyword`, `searchMemoryFactsByKeyword`/`searchExpertiseFacts`, `fetchRecentIndexScoresSince`/
  `fetchTopMentalPillarScores` → (M); `searchGroupsByTopicOrName`/`searchEntertainmentGroups` on
  `community_groups` (`:89,:93`) → (C); `fetchGroupMembersByGroupIds` → (M) on `user_id`;
  (b) members directory (`community-members-repository.ts`): `fetchHiddenCommunityProfileUserIds` (`:23`),
  `countProfilesExcludingSelf` (`:27`), `buildMembersListQuery` (`:31`) → (M);
  (c) superlatives (`superlatives-repository.ts`): `fetchHiddenCommunityProfileUserIds` (`:20`),
  `fetchAppUsersForHydration`, `fetchProfilesForHydration`,
  `fetchTopVitanaIndexScores` (`:35`), `fetchTopPillarScores`, `fetchProfilesByRegistrationOrder`,
  `fetchRelationshipsToUserIdProbe`/`FolloweeIdProbe` → (M); (d) `tool_global_search` **people
  (`discovery-tools.ts:172`) → (M), posts (`:188`) and events (`:216`) → (C); lanes ONLY**
  (groups/products/services already scoped, `:225+`); (e) **every** social-memory reader in
  `social-memory-repository.ts` that is not already `.eq('tenant_id')`: `fetchPeople` (`:72`),
  `fetchFollowEdges` (`:126`, followee/follower ids via `fetchPeople`), `fetchMatches` (`:169`, daily → (C),
  `user_matches` → (M) on the other party's column, two queries per chunk, R3-F2), `fetchCandidatePosts` (`:420`), `fetchPersonPosts` (`:472`), `fetchUpcomingEvents`
  (`:487`), `fetchEventParticipants` (`:500`, events pre-scoped (C) + participants (M)), `fetchEventsForUsers`
  (`:521`), `fetchGroupsForUsers` (`:539`), `fetchGroupNames` (`:557`), `fetchEventTitles` (`:570`),
  `fetchInterests` (`:583`), `resolvePersonByName` (`:649`), `fetchPersonById` (`:679`) — **each gains a
  `tenantId` parameter (breaking signature change)** and every importer of the repository passes the
  verified active tenant: `social-context-builder.ts`, `person-context-builder.ts`,
  `community-activity-builder.ts`, `social-read-tools.ts`, `social-memory-service.ts`,
  `routes/memory-social.ts`, `intent-find-match.ts:277`, `orb-tools/p0-gap-tools.ts:71`,
  `discovery-tools.ts` (incl. `tool_browse_news_feed`, `:313`). **`fetchPeople` hydration contract:**
  `fetchPeople(userIds, scope?)` takes an optional `scope: { memberIds: Set<string> }` and, when given,
  intersects `userIds` with it **before** the `.in('user_id', …)` at `:78`; `scope` is omitted only
  when the flag is off. Callers resolve `memberIds` once per request via `fetchActiveTenantMemberIds`
  and pass it explicitly: internal `fetchFollowEdges` (`:151`), `fetchMatches` (`:231`),
  `fetchPersonById` (`:680`); `resolvePersonByName` (`:649`) does NOT call `fetchPeople` — it applies `.in('user_id', memberIds)` to its OWN `.or()` query before `.limit(5)` and sanitises the `.or()` term (R3-F1); external `discovery-tools.ts:195` (posts
  authors) and `:368` (news feed), `community-activity-builder.ts:107`, `social-context-builder.ts:161`.
  The chat-derived hydrations `fetchRecentMessageContacts` (`:287`), `fetchUnreadMessageSummary`
  (`:354`) and `social-read-tools.ts:132` call `fetchPeople` **without** `scope` — deterministic and
  unchanged, because their peer ids come from chat rows already `.eq('tenant_id')`. **Out of scope, stated:**
  `fetchExclusions` (`:99`) and `fetchFollowFlags` (`:622`) read only the viewer's own rows (`.eq('user_id', userId)`) and return no other member; the `chat_*` reads are
  already `.eq('tenant_id')` (`:259,:337,:378,:612,:710`) and chat scope belongs to the Network sibling
  spec; `fetchActiveLifeCompassGoal` (`:685`) is viewer-own. (f) `connect-people`
  (`automation-handlers/connect-people-repository.ts`, scoped by the automation run's `ctx.tenantId`,
  `connect-people.ts:108`): the `daily_matches` readers `countTodaysUnviewedMatches` (`:77`),
  `fetchTopMatch` (`:86`), `fetchMatchById` (`:96`) and `fetchReciprocalAcceptedMatch` (`:100`) → (C)
  `.eq('tenant_id', tenantId)` (content table, class (i); legacy NULL-`tenant_id` matches are not
  surfaced with the flag on); `fetchTopUserInterests`/`fetchUserInterestNames` (`:112,:116`),
  `fetchUserDisplayName`/`fetchUserDisplayNamesIn` (`:122,:126`) and `fetchGroupMembersAmong` (`:198`)
  → (M); already `.eq('tenant_id')`, unchanged: `fetchPrimaryTenantUsers`, `fetchNotificationPrefs`,
  the `relationship_edges` reads, `countMessagesBetween`, `fetchPeerOpportunities`;
  `fetchGroupRecommendations` (`:186`) is viewer-own.
  **Social-memory resolver fix is a membership CHECK, not
  a rename**: verify `input.tenant_id` (`social-memory-service.ts:26`) is an active membership via WS1
  `is_member()` before any read, and reject a caller override. **Verified already scoped, no code change,
  read-only test only:** `resolve_recipient_candidates` (`p_global:false`). A lint bans a community read
  scoped only by visibility.
- **Lane `community-matches-v1` (CODE, vitana-v1, dark).** `generate-daily-matches` restricts its
  candidate pool to the viewer's active tenant behind the same flag; the new `daily_matches` tenant
  column (added in `community-tenant-db`) is written on insert. i18n DE-first for any new string.
## Migrations
Lane C version range **20261102060000–20261102065959** (NN=06) for `community-tenant-db` and
`founding-pool-tenant-db`; **the M2 `platform_only_accounts` migration is pinned to `20261102070160`**
(cross-spec C3, day-shifted with every multi-tenant re-plan so the order holds). No `20261102*` migration exists yet
(verified 2026-11-01). Each migration: expand/contract only, `bak_*` snapshot before data moves, pre-approved
rollback file under `docs/validation/<VTID>/`, read-only `live-before.sql` / `post-apply-checks.sql`,
one `RUN-MIGRATION.yml` dispatch per file, applied by Kiro after merge only on the owner's approval of the files and the target database (`collaboration.md` §7d). MIGRATION-QUEUE position:
after the WS1 resolver/membership migrations, in the order community tables → founding pool →
`20261102070160` platform_only_accounts.
## Tests
- pgTAP per table: a `b_member` session reads zero `T_A` community rows; a write with a foreign
  tenant fails; RLS on; realtime predicate present. Platform-only account invisible on every
  community surface. Founding count is per tenant. **Founding concurrency: parallel `claim_founding_seat`
  calls for the same tenant produce contiguous seat numbers with no `UNIQUE (tenant_id, seat_number)`
  violation, and two tenants may both hold seat 1 (per-tenant advisory lock proven).**
- Jest (gateway): each Community reader returns only the active tenant's members with the flag
  on, unchanged (visibility-only) with it off; the social-memory resolver REJECTS a tenant that is not
  an active membership (not merely ignores a tool arg); `fetchCandidatePosts`/`tool_browse_news_feed`
  and `fetchUpcomingEvents` return only the active tenant's posts/events once the `tenantId` parameter
  is threaded; `tool_global_search` people/posts/events lanes scoped while groups/products/services are
  unchanged; a read-only test asserts `resolve_recipient_candidates` stays tenant-scoped (no code change);
  `resolvePersonByName` with the flag on returns only an active-tenant member when the name matches members of two
  tenants, and a hint with `,` or `)` adds no `.or()` clause (R3-F1); `fetchMatches` never returns a cross-tenant
  `user_matches` counterpart whichever column holds the viewer, and returns a same-tenant one from both orders (R3-F2);
  the `connect-people` daily-match deliver / nudge / mutual-accept introduction paths surface only
  same-tenant `matched_user_id`s; `fetchPeople` with `scope` drops non-member ids at every listed
  internal and external call site, and the chat-derived hydrations are byte-identical.
- vitana-v1 Vitest: `generate-daily-matches` pool scoped; `daily_matches` tenant written.
- Isolation-suite semantics (program plan §4.11): Community surfaces return only the active tenant's
  rows; nothing private reachable. `npm run test:support` / `test:operator` only if those pipelines
  are touched (they are not here). Maxina golden suite byte-identical.
## Staging verification
Read-only (rule 48). A staging spec signs in as the test user and asserts the members directory /
`global_search` return only shared-tenant members with the flag on, and that no non-GET hits the
gateway. Writes/RLS proven by pgTAP + Jest only (staging uses the production Supabase project).
## Rollout
The gateway/edge **read path** is dark by default (`tenant_settings.feature_flags.mt.community_scope`),
flipped per tenant only after WS1's resolver is live and the isolation suite is green. The **RLS
policy-rewrite migration is NOT flag-gated**: it is sequenced in MIGRATION-QUEUE strictly after the
WS1 resolver/membership migrations AND after this spec's own deterministic `tenant_id` backfill, and
the rewritten read policies keep author-owned (`user_id = auth.uid()`) access for NULL-`tenant_id` rows
so an apply ahead of WS2 cannot deny reads. Migrations applied by Kiro via RUN-MIGRATION after merge, only on the owner's approval of the files and the target database (§7d),
with read-only post-checks. `SET NOT NULL` deferred to WS2. Owner step: approving each migration's files and target database (§7d).
## Risks
- Ordering vs WS1 (see Rollout): read filters are flag-dark so merging them early is inert; the
  non-flag-gated policy rewrite fails if applied before WS1's functions exist and would deny reads if
  applied before `tenant_id` is backfilled — mitigated by `depends_on` WS1, QUEUE sequencing after the
  resolver AND the backfill, and author-owned fallback for NULL-`tenant_id` rows.
- `profiles.tenant_id` empty until WS2 → scope by membership join, never by `profiles.tenant_id`.
- Realtime token staleness (program plan §4.2): tenant-shared policies also check `is_member`, so a
  stale socket cannot read a tenant it no longer belongs to.
- Founding per-tenant renumbering: swapping the global `UNIQUE`/`CHECK` for per-tenant ones must not
  collide on live data (two tenants may now both hold seat 1). Snapshot `bak_founding_members` first;
  validate the new per-tenant uniqueness against existing rows before dropping the global one; rollback.
## Out of scope
- The Network layer (O4-adjacent): `scope` columns, `network_visible`, `send_message`/`send_message_as`/
  `request_connection`, Network groups, Network recipient resolution — sibling spec.
- Moderation RPCs/triggers/event-games — mt-tenant-admin (cross-spec O4).
- WS1 resolver/membership/auth-hook; WS2 data cleanup and `SET NOT NULL`; WS4 provisioning;
  WS5 content packs; WS7 frontend tenant layer.
- Discover/commerce `distribution` scoping — mt-discover / commerce specs.
## Depends on
- WS1 identity & resolver spec **`mt-identity-r2`** (lanes `helpers-and-policy-rewrite`, `membership-unification`; `tenant_id_for_policies()`, `is_member()`, `TenantContext`,
  membership canonicalisation) — hard dependency for RLS + read filters.
- Done M0: VTID-05147 (S-M), 05149 (A: `tenants.is_default/is_platform`, `ci_tenant_isolation_health`),
  05150 (B), 05151 (C). The platform tenant (`is_platform=true`) that `platform_only_accounts` reads
  comes from VTID-05149.
- Cross-spec: O5 (this spec M2 creates `platform_only_accounts`; mt-discover references it), C3
  migration ordering (`20261102070160`), O4 (`content_reports` — this spec owns `tenant_id` + base RLS
  at `060*`; mt-tenant-admin's `moderator-tenant-scope-db` at `070600` sorts after and layers
  moderation policies on top, so the two never both own one policy).
## Owner decisions
Cites decided D1 (two scopes — Community half here), D8 (one active tenant per session; Community =
active tenant, not all memberships), D10 (Founding pool per tenant), D13 (no synthetic tenant in prod;
tests on the local stack). No new owner decision.
<!-- plan:end -->
## Open questions for sparring
- None open. The WS1 resolver owner is `mt-identity-r2` (Re-plan answers).
