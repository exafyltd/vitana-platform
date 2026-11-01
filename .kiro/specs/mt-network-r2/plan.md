---
change_class: standard
---
# mt-network — WS3 Network layer & community/network scopes (program §4.11 / §6 WS3) — mt-network-r2 (re-plan)

<!-- plan:begin -->
## Re-plan answers (session `0f65161a`, rounds 1–2)
Re-plan of `mt-network` (branch `kiro/mt-network/plan`). The PLAN-SPAR session `0f65161a` stopped at round 2 without an
answer. Its `s2-responses-1.md` had been written for another partner session (`c7a55d62`), so R1-F1 and R1-F4 were
never answered on their content. Every premise was re-verified on platform `origin/main` `62990ce285` and vitana-v1
`58c76c956` on 2026-11-01.
- **R1-F1** (the plan said several objects are vitana-v1-only, but the platform defines live bodies for them):
  accepted. Each object is defined as follows.
  - The tables `global_community_profiles` (v1 `20250917153624:5`), `daily_matches` and `connection_requests` (v1
    `20251111124306:2,24`) and `intent_matches` (v1 `20260501000200:13`) are created in vitana-v1.
  - The live function bodies `search_intent_catalog_v2` (`:38`), `compute_intent_matches(_v2)` (`:239`, `:102`) and
    the trigger `trg_gcp_hide_excluded_accounts` (`:331-332`) were last defined by platform
    `20261005120000_vtid_04888_rule45_intents_profiles.sql`. They are newer than any v1 redefinition (`20260616000000:78`).
  - Decision: **one tree for all of this spec's DB changes, the vitana-platform `supabase/migrations`**. The database
    is shared, and the platform already alters these v1 tables (the rule-45 trigger). So `network-visibility-db`,
    `legacy-messages-migration-db` and `matching-intent-scope-db` move to repo vitana-platform, seat `hotmail`. Their
    function changes are built on the `20261005120000` bodies.
  - Test: pgTAP asserts that `search_intent_catalog_v2`'s `p_visibility` no longer defaults to `'public'`, and that a
    rule-45 actor ends with `network_visible = false`. Both are red on `main`.
- **R1-F4 / R2-F1** (the "catch-all" `USING (true)` policies on `chat_groups`/`chat_group_members`/`chat_messages`):
  the premise is **false on `main`**. All three policies (`chat_groups_service_role`,
  `chat_group_members_service_role` and `service_role_manage_chat`) were dropped by
  `20260608120000_phase_a_security_hotfix.sql:25-27`. `service_role` bypasses RLS whatever the policies say (the
  hotfix header, `:5-8`).
  - The lanes now assert that the policies stay gone instead of dropping them: a pgTAP catalog check finds no permissive
    `FOR ALL` policy with `USING (true)` for `PUBLIC`/`authenticated` on these three tables.
  - The gateway's service-role writes are bounded by code. Membership changes go only through the DEFINER
    `add_group_member()`, which `routes/chat-groups-repository.ts` calls (dark).
  - A Jest lint fails on any `.from('chat_group_members')` insert/upsert/delete outside that wrapper.
  - pgTAP: `add_group_member()` refuses a caller who is not a member of the group, and refuses a non-connection for a
    Network group.
- **R2-F2** (the writer lint keyed on function names): accepted.
  - `chat-writer-inventory` plus `test/mt-network-chat-writer-lint.test.ts` scan `services/gateway/src/**/*.ts` with
    a multiline `\.from\(\s*['"](chat_messages|global_messages)['"]\s*\)\s*\.(insert|upsert)`. A hit outside the
    `send_message(_as)` wrappers and the allowlisted system writers fails.
  - The insert sites on `main` are all listed and in `messaging-send-gateway`'s `paths`:
    - `routes/chat-repository.ts:21,93`
    - `routes/chat-groups-repository.ts:94,100`
    - `routes/intents-share-repository.ts:44`
    - `services/companion/companion-repository.ts:322`
    - `services/intent-notifier-repository.ts:35`
    - `services/orb-tools-shared.ts:2676,3025`
    - `services/orb-tools/messaging-depth-tools-repository.ts:52`
    - `orb/live/session/upstream-message-handler-repository.ts:33`
  - The lint is red on `main`.
- **Corrections:**
  - Lane paths now point at the real files. `intents-share-repository` and `chat-groups-repository` are under
    `routes/`, and `upstream-message-handler-repository` is under `orb/live/session/`.
  - The Find-a-Match lane uses `useRealMatches.ts`, `components/intents/FindMatchFilterSheet.tsx` and the
    `screens.json` shards (a hot file, sequenced).
  - Overlapping lanes are sequenced:
    - `orb-recipient-scope-gateway` after `messaging-send-gateway` (`orb-tools-shared.ts`)
    - `network-groups-gateway` after `messaging-send-gateway` (`chat-groups-repository.ts`)
    - `network-groups-v1` after `messenger-wiring` (`Messages.tsx`, `components/messages/**`)
  - Apply order follows `depends_on`: `network-visibility-db` first.
  - Line refs: `chat.ts` `/send` `:124`, insert `:226-237`, `/vitana-reply` `:441`; `Messages.tsx:154-156`.
- **Migration versions:** day-shifted with every multi-tenant re-plan: `20261102050000`–`055959` (free). The old
  `20261102050*` slots would sort before migrations already on `main`.
- **Dependencies named:**
  - `mt-identity-r2` provides `tenant_id_for_policies()` and `is_member()`.
  - `mt-community-isolation-r2` provides `platform_only_accounts` at `20261102070160` and the community scope.
  - The rule-45 exclusion set on `main` is `service_bot_accounts` + `notification_test_actors`.
- **Roles on today's rules:** every lane is `executor: kiro`, `next_actor: kiro`, `reviewer_seat:
  agent:vitana-lane-reviewer`. Migrations are applied by Kiro through `RUN-MIGRATION.yml`, only after the owner
  approves the files and the target database (§7d).

## Problem
Verified today (2026-10-15) in `vitana-platform-1` and `vitana-v1` HEAD. Program §4.11 line refs are from 2026-10-06/10; re-verified below.

1. **Messenger switch is inverted and mislabelled.** `src/pages/Messages.tsx:153-154` builds `inboxModes` as `{value:'global', label 'Community'}` / `{value:'tenant', label 'Network'}` — the `tenant` context is the legacy role-gated professional channel, not a tenant/network split. There is no `scope` concept anywhere.
2. **`chat_messages` client INSERT is unguarded.** The gateway `/send` route (`services/gateway/src/routes/chat.ts:124`) runs under a service-role client (`getSupabase()` → `SUPABASE_SERVICE_ROLE`, `:118`) and writes `tenant_id: identity.tenant_id, sender_id: identity.user_id` (`:125-129`) via `insertChatMessage` (`services/gateway/src/routes/chat-repository.ts:20-23`). The authenticated INSERT policy only checks `sender_id = auth.uid()`, so any member can send a DM with any client-supplied `tenant_id`; the catch-all `service_role_manage_chat` policy (`20260225200000_chat_messages.sql:35-38`) was already dropped by `20260608120000_phase_a_security_hotfix.sql:25`, but `service_role` bypasses RLS anyway (hotfix `:5-8`), so any service-role client (incl. `getSupabase()`+`insertChatMessage`) still bypasses scope — only code can bound it. There is no `scope` column and no `send_message()`/`send_message_as()` RPC (grep: zero hits for `send_message_as`/`request_connection`/`respond_connection`). **`chat_messages`/`chat_groups` are vitana-platform tables** (`20260225200000`, `20260525000000`).
3. **`connection_requests` is self-grantable — and it is a vitana-v1 table.** `connection_requests` is defined in vitana-v1 (`supabase/migrations/20251111124306_...sql:24`), not platform. Its INSERT checks only `from_user_id = auth.uid()` and `status` is client-writable, so a sender can self-insert `accepted`. No `request_connection()`/`respond_connection()` exists. Because the table lives in v1, its RPCs/revokes are a **v1** migration (not platform).
4. **No network-presence opt-in.** `global_community_profiles.is_visible` governs the community directory + public web profile; there is no `network_visible` column, so there is no opt-in reduced-profile Network presence and no rule-45 force-off for it.
5. **Matching is network-wide by accident and health-fed — all in vitana-v1.** The nightly recompute `supabase/functions/generate-daily-matches/index.ts` (vitana-v1) pools all `is_visible` `global_community_profiles` across tenants (`:111`), scores on `vitana_index_scores` (`:181`), writes `daily_matches` (`:150,291,297`) whose `match_reasons` jsonb (v1 `20251111124306:2-7`) carries health codes; no `scope`/`tenant` column. Intent matchers (`intent_matches`/`compute_intent_matches`, `20260501*`) are **also v1** (`p_visibility` default `'public'`). This is NOT the platform matchmaking-engine `matches_daily` (`20251231000001`) — this spec targets the v1 `daily_matches`/intent system, so the matching DB lane is a **vitana-v1** migration.
6. **ORB recipient resolution has no scope.** `services/gateway/src/services/orb-tools-shared.ts:2054-2061,2278-2282,2431-2435` call `resolve_recipient_candidates(p_global:true)` with no visibility gate — voice can reach any registered member of any tenant.
7. **Network groups do not exist.** `chat_groups`/`chat_group_members` have no `scope`; D27 small invite-only cross-tenant groups are unbuilt. 60 legacy cross-tenant `global_message_threads` stay read-only until built.

## Fix (per lane; DB split from code per §4.7)
- **`messaging-send-db`** (hotmail, **platform** DB — `chat_messages`): add `chat_messages.scope text NOT NULL CHECK (scope IN ('community','network'))` expand/contract (`DEFAULT 'community'` during migrate, then drop default); **assert the catch-all `service_role_manage_chat` policy stays gone** (dropped by `20260608120000:25`; pgTAP catalog check: no permissive `FOR ALL USING (true)` policy for `PUBLIC`/`authenticated` on `chat_messages`) — `service_role` bypasses RLS, so the direct-insert bypass is closed in code: every gateway insert goes through `send_message_as` and the `.from()` writer lint (R2-F2); revoke the authenticated client INSERT on `chat_messages`; create SECURITY DEFINER `send_message(p_peer|p_group,p_scope,p_body,…)` (sender from `auth.uid()`, derives `tenant_id` server-side; community = shared active tenant; network = both members `network_visible` + recipient messaging preference + blocks + first-contact rate limit) called with the user JWT, and `send_message_as(p_sender,…)` (same body, EXECUTE to `service_role` only, `p_sender` from the gateway's verified identity). pgTAP: a bare authenticated client INSERT fails; the writer lint reports no direct `chat_messages`/`global_messages` insert outside the wrappers; a `send_message` to a "nobody" or non-`network_visible` recipient fails.
- **`messaging-send-gateway`** (jtadic, gateway): rewrite `/send` (`chat.ts:54`) to call `send_message()` with the user JWT (not service role); route the gateway member-on-behalf sends — ORB voice send/share-link, intent share, gateway group send, ORB live bridge — through `send_message_as()` using `req.identity`/ORB session identity; thread identity `(scope, tenant_id if community, peer)` in the recent-conversations RPC path; add a generated writer inventory + lint allowing `chat_messages`/`global_messages` inserts only inside these two functions plus an allowlist of true system writers (bot `/vitana-reply` `chat.ts:281`, welcome-chat, notification bots) that always write `scope='community'`. Jest/contract: an ORB voice send to a non-`network_visible` member of another tenant is refused; an intent share to a "nobody" recipient is refused.
- **`network-visibility-db`** (hotmail, **vitana-v1** DB — `global_community_profiles` + `connection_requests` both live in v1, `20250917153624`/`20251111124306`): add `global_community_profiles.network_visible boolean NOT NULL DEFAULT false` + `network_visible_decided_at` + `messaging_preference`; rule-45 trigger forces `network_visible=false` for rule 43–45 (`service_bot_accounts`/`notification_test_actors`/`platform_only_accounts`) and `is_visible=false` exclusions; existing members backfilled `false`. Also revoke client INSERT/UPDATE on `connection_requests` and add SECURITY DEFINER `request_connection()`/`respond_connection()` (caller bound to `auth.uid()`, only recipient sets `accepted`, network request requires `network_visible` + preference ≠ nobody + no block + rate limit, free-text `message` capped and dropped for network) — these are v1 tables so they belong in the v1 migration, not platform. pgTAP: a rule-45 actor cannot be set `network_visible=true`; a self-inserted `accepted` connection fails; a network `request_connection` to a non-`network_visible`/"nobody" recipient fails.
- **`messenger-wiring`** (exafyltd, messenger area, v1): fix the inverted `inboxModes` labels/values to `scope` (`community`→"Community", `network`→"Netzwerk/Network", mobile + desktop); remove `useHybridMessages` role routing and the legacy `tenant` context; wire `useGlobalMessages` thread dedup to `(scope, tenant_id if community, peer)`; one-time in-app network-visibility prompt (recorded Maxina golden exception). i18n DE-first du-form.
- **`legacy-messages-migration-db`** (hotmail, **vitana-v1** DB — `global_messages`/`global_message_threads` are v1 tables, `20250917153624`): freeze+migrate `global_message_threads`/`global_messages` (60/379) into the shared `chat_messages`/`chat_groups` surface per the single migration rule (shared tenant → Community, else Network); drop the legacy tables after. Source tables are v1, `chat_*` targets platform (one Supabase project), so the v1 migration writes the platform `chat_*` rows; depends on `messaging-send-db` + `network-visibility-db`. Snapshot `bak_*` (30 days). pgTAP on the mapping.
- **`matching-intent-scope-db`** (hotmail, **vitana-v1** DB — `daily_matches`/`intent_matches`/`compute_intent_matches` are v1): add `daily_matches.scope` (+ tenant context) and backfill per D15 (respect the existing unique key `(tenant_id,user_id,match_date,match_type,target_id)`); change the intent matchers' `p_visibility` default from `'public'` to the caller scope, mapping `community`→tenant branch, `network`→public branch restricted to `network_visible`; **remove Vitana Index inputs from matching so `daily_matches.match_reasons` carries no health-derived code (D25)**; register the v1 recompute (`generate-daily-matches` Edge Function) + intent matchers in the lineage-guard inventory. pgTAP + a `match_reasons` no-health-code test. NB `resolve_recipient_candidates` scope lives in `orb-recipient-scope-gateway`, not here.
- **`orb-recipient-scope-gateway`** (jtadic, gateway): ORB scope (`orb-tools-shared.ts:2054-2061,2278-2282,2431-2435` recipient tools, `find_community_member`, superlatives, `global_search`) default community, network only on explicit ask and only to `network_visible` recipients whose preference allows; enforced in the handler/dispatcher, not the prompt. Dispatcher tests on Nova and the Vertex bridge.
- **`matching-discover-scope-v1`** (exafyltd, v1): Discover/Find-a-Match scope control wiring and the `generate-daily-matches` scoped pool (network pool = `network_visible` only, no Vitana Index inputs per D25). Vitest for the scoped pool + read-only staging spec; i18n DE-first; Spotlight on touched screens.
- **M3, flagged (`mt.network_groups`): `network-groups-db`** (hotmail, platform DB) — `chat_groups.scope`/`chat_group_members.scope`; participant-only RLS; `add_group_member()` DEFINER with D27 rules (≤20, invite-only between connections, no system fan-out, creator tenant as context); **`network-groups-gateway`** (jtadic, gateway) — route network-group create/join through `add_group_member()`, D27 enforced server-side; and **`network-groups-v1`** (exafyltd, v1) — network-group create/invite UI + "Netzwerk" labels. These are the LAST lanes and mt-network OWNS them (CROSS-SPEC "Network groups"); mt-m3 only references them.

## Migrations
Range `20261102050000`–`20261102055959` (NN=05) in **both** trees (one Supabase project). **Platform tree:** `messaging-send-db` (`chat_messages`), `network-groups-db` (`chat_groups`). **vitana-v1 tree:** `network-visibility-db` (`global_community_profiles` + `connection_requests`), `legacy-messages-migration-db` (`global_messages`), `matching-intent-scope-db` (`daily_matches`/intent). Each ships a rollback under `docs/validation/<vtid>/` + read-only pre/post checks; data moves snapshot `bak_*` (30 days). Expand/contract for `scope`. Apply order: platform `messaging-send-db` → v1 `network-visibility-db` → v1 `legacy-messages-migration-db` → v1 `matching-intent-scope-db` → (M3) platform `network-groups-db`. Kiro applies via RUN-MIGRATION on the owner's approval (§7d); auth untouched.

## Tests
Vitest/Jest (gateway + v1), pgTAP (every new RPC, trigger, revoke, scope predicate), contract tests (ORB voice/intent-share refusals, scope isolation per §4.11 semantics), golden (`npm run test:support` rule 42c for the messaging/ticket path; Maxina golden suite byte-identical — the one-time network prompt is the single recorded exception). Isolation suite asserts: community surfaces return only the active tenant's rows; network surfaces return only rows explicitly `scope='network'` and only `network_visible` members' Network profile fields; nothing private (health/memory/diary/tenant-only groups) is reachable via any network surface; opted-out and rule 43–45 accounts never appear in either scope.

## Staging verification
Read-only (rule 48). Playwright on `preview-aws-gateway`/`preview-aws` signs in as the test user, opens the messenger, confirms the two scope labels render correctly and the network opt-in prompt shows; a network guard aborts every non-GET to the gateway and Supabase REST except sign-in. No write suite ever targets production. Each lane adds its `docs/validation/<vtid>/staging-tests.json`.

## Rollout
Dark by default behind `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*` (`mt.network_enabled` for the Network surfaces, `mt.network_groups` for the M3 group lanes). DB migrations are live on apply (one Supabase project) and follow the §4.7 slice protocol; read paths stay behind the flags. Kiro applies migrations via RUN-MIGRATION after merge, only on the owner's approval of the files and the target database (§7d); the owner approves no auth-hook step here (none in scope).

## Risks
- Revoking client INSERT on `chat_messages`/`global_messages` breaks any writer not routed through the two RPCs → the writer inventory/lint + allowlist must be complete before the revoke migration applies; keep the revoke in its own DB slice after the gateway code merges dark.
- The legacy-message migration is a data move → snapshot + pre-approved rollback from `bak_*`; freeze `global_messages` read-only before migrating.
- Rate-limit/preference checks inside `send_message` run per send on a hot table → evaluate predicates once (initPlan via `(select …)`), index `connection_requests`/preference lookups.
- Removing Vitana Index from matching changes member-visible match reasons → covered by the recorded golden exception and the `match_reasons` test.

## Out of scope
Community-side tenant scoping of feed/directory/`find_community_member` beyond messaging/matching/ORB (WS3 Community part, separate spec/lanes); events/live-rooms network scope (follow-up); the access-token hook and `tenant_id_for_policies()` (WS1/mt-identity); health-table re-keying (WS10/mt-native-health); Discover distribution `community|network` catalog gating (WS11/mt-discover — this spec only wires the Find-a-Match/messenger scope control, not supplier eligibility).

## Depends on
- Done M0: VTID-05147 (S-M membership/role lockdown), 05149 (default/platform tenant), 05150 (brand pack/provision), 05151 (public registry).
- mt-identity: `tenant_id_for_policies()`/`is_member()` and the access-token claim (community reads add `tenant_id = tenant_id_for_policies()`). This spec's community-scope predicates reference them; where not yet live, community reads fall back to the membership join as WS3 states.
- mt-guardrails: the lineage-guard inventory (matching joins it) and `isHealthTable()` (CROSS-SPEC O1, owned by mt-identity).
- CROSS-SPEC: "Network groups" (owned here), "Lane count" (merge rule applied).

## Owner decisions
Implements decided D1 (two scopes), D15 (existing-data migration rule), D23 (network_visible default false + onboarding choice + one-time prompt + connections-only default + staffed Exafy network moderation), D25 (Vitana Index removed from matching), D27 (network groups M3, flagged, ≤20 invite-only). No new decision proposed.
<!-- plan:end -->

## Open questions for sparring
- Messaging-preference storage: a new `global_community_profiles.messaging_preference` column vs a dedicated table — proposed: a column (everyone/connections/nobody, default connections), decided at implementation; cross-spec only if mt-identity-r2 adds a conflicting profile column.
- First-contact rate-limit store (per-sender across tenants): proposed a small `message_first_contact_log` table; confirm no existing rate-limit table should be reused.
