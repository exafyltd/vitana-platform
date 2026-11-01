# Tasks — mt-community-isolation-r2 (WS3 Community part; re-plan of mt-community-isolation)

Authoritative plan: `plan.md`. Lane files: `lanes/`. VTIDs allocated by PLAN-SPAR after approval.
Each lane adds its own `docs/validation/<VTID>/` (plan copy, `scope.json`, `staging-tests.json`),
which is intentionally not in the Allowed paths globs below (per the brief).
Every lane: `executor: kiro`, reviewed by `agent:vitana-lane-reviewer`; trailers `Collab-Session` /
`Collab-Lane: mt-community-isolation-r2/<lane>`. The three DB lanes share the hot file
`docs/multitenancy/MIGRATION-QUEUE.md` and land in order community-tenant-db → founding-pool-tenant-db →
platform-only-accounts-db. Migrations are applied by Kiro through `RUN-MIGRATION.yml` only after the owner approves
the files and the target database (`collaboration.md` §7d), and not before `mt-identity-r2`'s
`helpers-and-policy-rewrite` and `membership-unification` migrations are applied.

<!-- lane: community-tenant-db -->
## community-tenant-db — community tables tenant_id + RLS (repo vitana-platform)

Allowed paths: `supabase/migrations/20261102060*.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`,
`supabase/tests/mt_community_isolation_*.sql`.

VTID: allocated by PLAN-SPAR after approval.

- [ ] T1 Add `tenant_id uuid` (nullable) + FK to `tenants` on the tenant-scoped content tables
      `profile_posts`, `global_community_groups`, `global_community_events`, `media_uploads`,
      `community_live_streams`, `calendar_events`, `content_reports`, `feedback_tickets`,
      `daily_matches` (BEFORE INSERT trigger fills the writer's active tenant) and on the child table
      `global_community_group_members` (trigger copies the parent group's `tenant_id`). **No
      `tenant_id` on the per-user `global_community_profiles`** (`user_id` UNIQUE, users are 1:N in
      `user_tenants`) — it is scoped by a membership predicate in T3. Version `20261102060000`.
- [ ] T2 Deterministic batched backfill (1–5k/txn, off-peak), `bak_*` snapshot first: content rows get
      the author's only membership, else their single `is_primary` membership, else stay NULL (no
      guess; read-only pre-check counts them); group members copy their group's `tenant_id`. Then
      `CHECK (tenant_id IS NOT NULL) NOT VALID`, `VALIDATE` only once the NULL count is 0. **No `SET
      NOT NULL`** (WS2).
- [ ] T3 These tables already have RLS enabled with permissive policies — **rewrite** (do not newly
      enable) every policy: user-private (`user_id = auth.uid() AND tenant_id =
      tenant_id_for_policies()`), tenant-shared (`is_member(tenant_id)`), admin-only
      (`is_tenant_admin(tenant_id)`); confirm `ROW LEVEL SECURITY` is enabled on each; add the realtime
      tenant predicate for realtime-reachable tables. `global_community_profiles` policies use the
      membership predicate `EXISTS (user_tenants WHERE user_id = row.user_id AND is_member(tenant_id))`
      instead of a column. Rewritten SELECT policies keep author-owned
      (`user_id = auth.uid()`) read access for NULL-`tenant_id` rows. For `content_reports` rewrite
      `tenant_id` + base RLS only — mt-tenant-admin's `moderator-tenant-scope-db` (`070600`) layers
      moderation policies on top (O4). **The policy rewrite is NOT flag-gated**; its MIGRATION-QUEUE
      row (T4) is placed strictly after the WS1 resolver/membership rows AND after the T2 backfill.
- [ ] T4 Rollback migration + `live-before.sql` / `post-apply-checks.sql` under
      `docs/validation/<VTID>/`; add MIGRATION-QUEUE rows after the WS1 resolver/membership rows.
- [ ] T5 pgTAP `supabase/tests/mt_community_isolation_*.sql`: `b_member` reads 0 `T_A` rows per table;
      a foreign-tenant write fails; RLS enabled; realtime predicate present; a `T_A`+`T_B` member's
      profile is visible in both tenants; an ambiguous author's post stays NULL and author-only.

Acceptance: migrations expand-only, `lock_timeout`+retries, snapshot before data move, rollback +
pre/post checks present, MIGRATION-QUEUE updated, pgTAP green. No `SET NOT NULL`. Kiro never applies a
migration against any live system.

<!-- lane: founding-pool-tenant-db -->
## founding-pool-tenant-db — Founding pool per tenant (repo vitana-platform)

Allowed paths: `supabase/migrations/20261102061*.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`,
`supabase/tests/mt_founding_pool_*.sql`.

VTID: allocated by PLAN-SPAR after approval.

- [ ] F1 **No column add, no `tenant_id` backfill** — `founding_members.tenant_id` and
      `claim_founding_seat(p_user_id, p_tenant_id)` already exist and are populated (VTID-04859,
      `20261003100000_vtid_04859_founding_1000.sql:60,99-112`). Migration `20261102061000`:
      `bak_founding_members` snapshot first, verify `tenant_id` is already populated (fail loudly if
      any row is NULL), then replace the global `seat_number ... UNIQUE` + `CHECK (seat_number BETWEEN
      1 AND 1000)` (`:57,:127`) with `UNIQUE (tenant_id, seat_number)` and a per-tenant cap check,
      validated against existing rows before dropping the global constraints.
- [ ] F2 Rewrite `claim_founding_seat` so the seat sequence is per tenant (replace the table-wide
      `COALESCE(max(seat_number),0)+1` at `:127` with a `WHERE tenant_id = v_tenant_id` max) and
      `v_max_seats` is the per-tenant cap. The existing tenant resolution (`p_tenant_id` →
      `user_tenants`) and the advisory lock stay; make the lock key per tenant so two tenants do not
      serialise against each other.
- [ ] F3 Rollback migration + read-only pre/post checks under `docs/validation/<VTID>/`; MIGRATION-QUEUE
      row after the community-tables rows.
- [ ] F4 pgTAP `supabase/tests/mt_founding_pool_*.sql`: two tenants each seat independently up to the
      cap; a seat is counted only in its own tenant; two tenants can both hold seat 1.

Acceptance: no column add / no `tenant_id` backfill (verified populated instead), snapshot + rollback +
pre/post checks, per-tenant cap and per-tenant seat numbering proven by pgTAP. Gateway reporting lives
in `community-scope-gateway`. Kiro never applies a migration live.

<!-- lane: platform-only-accounts-db -->
## platform-only-accounts-db — platform_only_accounts view, M2 / O5 (repo vitana-platform)

Allowed paths: `supabase/migrations/20261102070160_*.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`,
`supabase/tests/mt_platform_only_accounts_*.sql`.

VTID: allocated by PLAN-SPAR after approval.

- [ ] P1 Create `platform_only_accounts` view (platform-tenant members with no community membership)
      in migration **`20261102070160`** (pinned, cross-spec C3 — do not renumber).
- [ ] P2 Add the view to the rule-45 exclusion lint beside `service_bot_accounts` /
      `notification_test_actors`.
- [ ] P3 MIGRATION-QUEUE row as the C3 position (after the two `20261102060*` lanes) + drift-baseline
      entry (removed after apply); rollback + read-only pre/post checks under `docs/validation/<VTID>/`.
- [ ] P4 pgTAP `supabase/tests/mt_platform_only_accounts_*.sql`: a platform-only account appears in the
      view and never in any community-member surface.

Acceptance: view created at version `20261102070160`, rule-45 lint extended, pgTAP green, QUEUE +
baseline updated. Kiro never applies a migration live.

<!-- lane: community-scope-gateway -->
## community-scope-gateway — Community read surfaces scoped to active tenant (repo vitana-platform)

Allowed paths: `services/gateway/src/services/voice-tools/community-member-ranker.ts`,
`services/gateway/src/services/voice-tools/community-member-ranker-repository.ts`,
`services/gateway/src/services/voice-tools/superlatives.ts`,
`services/gateway/src/services/voice-tools/superlatives-repository.ts`,
`services/gateway/src/routes/community-members.ts`,
`services/gateway/src/routes/community-members-repository.ts`,
`services/gateway/src/routes/users-resolve.ts`,
`services/gateway/src/routes/users-resolve-repository.ts`,
`services/gateway/src/routes/billing.ts`, `services/gateway/src/routes/billing-repository.ts`,
`services/gateway/src/services/orb-tools/discovery-tools.ts`,
`services/gateway/src/services/social-memory/**`, `services/gateway/src/routes/memory-social.ts`,
`services/gateway/src/services/intent-find-match.ts`, `services/gateway/src/services/orb-tools/p0-gap-tools.ts`,
`services/gateway/src/services/automation-handlers/connect-people.ts`,
`services/gateway/src/services/automation-handlers/connect-people-repository.ts`,
`services/gateway/test/mt-community-*.test.ts`.

VTID: allocated by PLAN-SPAR after approval.

- [ ] G1 Behind `feature_flags.mt.community_scope`, add `fetchActiveTenantMemberIds(sb, tenantId)`
      (`community-members-repository.ts`) and scope every reader listed in plan Fix (a)–(d),(f) — the
      ranker, members directory, superlatives, `tool_global_search` people/posts/events and
      `connect-people` — by (M) `.in(<user-id column>, memberIds)` before order/limit, chunked at 200,
      for per-user tables, or (C) `.eq('tenant_id')` for column tables. In `connect-people-repository.ts`
      (scope = the run's `ctx.tenantId`) the `daily_matches` readers `countTodaysUnviewedMatches`,
      `fetchTopMatch`, `fetchMatchById`, `fetchReciprocalAcceptedMatch` are (C); `user_interests` /
      `app_users` / `fetchGroupMembersAmong` reads are (M). `resolve_recipient_candidates`
      is already scoped: read-only test only, no code change. Flag off = unchanged.
- [ ] G2 Social-memory: verify `input.tenant_id` is an active membership (reject otherwise), then give
      every reader in plan Fix (e) a `tenantId` parameter (`fetchPeople`, `fetchFollowEdges`,
      `fetchMatches`, `fetchCandidatePosts`, `fetchPersonPosts`, `fetchUpcomingEvents`,
      `fetchEventParticipants`, `fetchEventsForUsers`, `fetchGroupsForUsers`, `fetchGroupNames`,
      `fetchEventTitles`, `fetchInterests`, `resolvePersonByName`, `fetchPersonById`) and update every
      importer (`social-memory/**` incl. `person-context-builder.ts:52`, `routes/memory-social.ts`,
      `intent-find-match.ts:277`, `orb-tools/p0-gap-tools.ts:71` (`resolveMember` gets `id` from `:90`, `:127`,
      `:488`), `discovery-tools.ts` incl. `tool_browse_news_feed`).
      `fetchPeople(userIds, scope?)` intersects with `scope.memberIds` before `.in(...)`; pass it from
      `fetchFollowEdges`, `fetchMatches`, `fetchPersonById`,
      `discovery-tools.ts:195,:368`, `community-activity-builder.ts:107`, `social-context-builder.ts:161`;
      the chat-derived `fetchRecentMessageContacts`, `fetchUnreadMessageSummary` and
      `social-read-tools.ts:132` call it without `scope` (unchanged). Viewer-own reads (`fetchExclusions`, `fetchFollowFlags`,
      `fetchActiveLifeCompassGoal`) and the already-scoped `chat_*` reads are unchanged.
- [ ] G2a (R3-F1) `resolvePersonByName` (`social-memory-repository.ts:649`) scopes its OWN `profiles` `.or()` query:
      with the flag on, `.in('user_id', chunk)` per 200-id chunk of `memberIds` before `.limit(5)`, hits merged
      before `best` is chosen. Strip the PostgREST `.or()` reserved characters `,()*:."\` from the term (today only
      `%`/`_`, `:652`).
- [ ] G2b (R3-F2) `fetchMatches` (`:169`): `user_matches` read as two queries per chunk,
      `.eq('user_id_1', viewer).in('user_id_2', chunk)` and `.eq('user_id_2', viewer).in('user_id_1', chunk)`, each
      with the existing order/limit, merged, re-sorted by `matched_at`, cut to `limit`; the `daily_matches` half is
      (C) `.eq('tenant_id', tenantId)`.
- [ ] G3 `countFoundingSeats` / `/founding-status` report per the viewer's tenant (read-only).
- [ ] G4 A lint/test banning a community read scoped only by visibility (no tenant predicate).
- [ ] G5 Jest in `services/gateway/test/mt-community-*.test.ts`: each reader returns only the active tenant's members with
      the flag on, byte-identical with it off — one case per reader in G1/G2, incl. top-N index
      scores filled from the active tenant; resolver rejects a non-member tenant; `connect-people`
      daily-match deliver/nudge/introduction surface only same-tenant `matched_user_id`s; `fetchPeople`
      with `scope` drops non-member ids at each listed call site, chat-derived hydrations unchanged.

Acceptance:
- Change types: Backend.
- Dark by default, Network scope untouched, lint green, full gateway Jest suite green, Maxina golden suite
  byte-identical; each new test recorded red on `origin/main` first; Kiro never writes to a live system.
- The two carry-over acceptances below (R3-F1, R3-F2) hold.
- PR title `VTID-xxxxx (mt-community-isolation-r2/community-scope-gateway): …`.

<!-- lane: community-matches-v1 -->
## community-matches-v1 — daily matches candidate pool scoped (repo vitana-v1)

Allowed paths: `supabase/functions/generate-daily-matches/**`, `src/i18n/de/matches.json`,
`src/i18n/en/matches.json`.

VTID: allocated by PLAN-SPAR after approval.

- [ ] M1 Behind `feature_flags.mt.community_scope`, scope the `generate-daily-matches` candidate pool
      to the viewer's active tenant; keep the rule-45 exclusion. Flag off = unchanged.
- [ ] M2 Write the `daily_matches` tenant column (from `community-tenant-db`) on insert.
- [ ] M3 Any new user-visible string DE-first du-form in `src/i18n/de/matches.json`, mirrored to
      `src/i18n/en/matches.json`; `match_reasons` stays `{key, params}`; `npm run i18n:inventory`.
- [ ] M4 Vitest: pool scoped with the flag on, unchanged off; tenant written on insert.

Acceptance: dark by default, Network untouched, Vitest + full `npx vitest run` green, ESLint i18n
clean. Kiro never runs the edge function against production.

## Escalation carry-over (from `mt-community-isolation`, session `ed136e24`, round 3)
Each finding is answered in `plan.md` "Re-plan answers"; the tasks carry the acceptance.
- R3-F1 [major], verbatim: "The plan states resolvePersonByName gains tenant scope 'via fetchPersonById (:680)' and
  'so resolvePersonByName', but resolvePersonByName does NOT call fetchPersonById or fetchPeople. It performs its own
  direct `.or('display_name.ilike...,full_name.ilike...,handle.ilike...,vitana_id.ilike...')` query on `profiles`
  with `.limit(5)` (:655-659) and then calls `mapPerson(best)` directly. The (M) mechanism (`.in('user_id',
  memberIds)` added before ordering/limit) must therefore be applied to resolvePersonByName's OWN `.or()` query, not
  inherited through a non-existent call chain. As written, with the flag on, resolvePersonByName would still perform a
  network-wide fuzzy name search and return cross-tenant members — the exact tenant-isolation leak R1-F2 flagged in
  round 1, still unresolved in its mechanism."
  Task: `community-scope-gateway` G2a.
  Acceptance: `test/mt-community-resolve-person.test.ts` stubs `profiles` with two members named "Ana", one in tenant
  A and one in tenant B. With the flag on, a tenant-A viewer resolves only the tenant-A member. The recorded query
  carries `.in('user_id', …)` before `.limit(5)`. A hint `"Ana,user_id.neq.x"` produces an `.or()` string with no
  extra clause. Flag off: the result is unchanged. The flag-on and injection cases are red on `origin/main`.
- R3-F2 [minor], verbatim: "The (M) mechanism enumerates columns to filter as `user_id | to_user_id | followee_id |
  following_id | follower_id`, but `fetchMatches` reads `user_matches` via a two-column
  `.or('user_id_1.eq.${userId},user_id_2.eq.${userId}')` (:187). The plan maps 'user_matches → (M)' without
  specifying how the memberIds intersection applies to a two-column OR (neither `user_id_1` nor `user_id_2` appears
  in the enumeration)."
  Task: `community-scope-gateway` G2b.
  Acceptance: `test/mt-community-fetch-matches.test.ts` covers four mutual matches: viewer in `user_id_1` and in
  `user_id_2`, each with an in-tenant and a cross-tenant counterpart. With the flag on, only the two in-tenant
  counterparts are returned. Daily matches with another `tenant_id` are not returned. Flag off: the result is
  byte-identical. The flag-on cases are red on `origin/main`.
