# Tasks — mt-network (WS3 Network layer)

Authoritative plan: `plan.md`. Lane files: `lanes/`. VTID: allocated by PLAN-SPAR after approval.

<!-- lane: messaging-send-db -->
## messaging-send-db — chat_messages scope, send RPCs, RLS lockdown (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-platform)

Allowed paths: `supabase/migrations/20261102050***_*.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json`, `services/gateway/test/mt-network-messaging-send-db.pgtap.test.ts`

- [ ] 1 Expand/contract migration: add `chat_messages.scope` CHECK `('community','network')`, `DEFAULT 'community'`, backfill, drop default. (`messaging_preference` moved to `network-visibility-db`.)
- [ ] 2 `send_message()` / `send_message_as()` SECURITY DEFINER with the §4.11 community/network checks; `send_message_as` EXECUTE to `service_role` only.
- [ ] 3 Assert the catch-all `service_role_manage_chat` policy stays gone (dropped by `20260608120000:25`; pgTAP catalog check, re-plan R1-F4); revoke the authenticated client INSERT on `chat_messages`. (The `connection_requests`/`global_messages` revokes moved to the v1 lanes.)
- [ ] 4 Rollback migration under `docs/validation/<vtid>/` + read-only pre/post checks; MIGRATION-QUEUE rows in position; drift-baseline entries for not-yet-live objects.
- [ ] 5 pgTAP: a bare authenticated client INSERT fails; a direct service-role INSERT fails after the policy drop; a `send_message` to a "nobody"/non-`network_visible` recipient fails; a community send without a shared tenant fails.

Acceptance: pgTAP green locally; migration files lint; MIGRATION-QUEUE updated in the same PR; rollback present. Migrations are applied by Kiro via RUN-MIGRATION only on the owner's approval of the files and the target database (§7d).

<!-- lane: messaging-send-gateway -->
## messaging-send-gateway — route sends through the RPCs + writer lint (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-platform)

Allowed paths: `services/gateway/src/routes/chat.ts`, `services/gateway/src/routes/chat-repository.ts`, `services/gateway/src/services/orb-tools-shared.ts`, `services/gateway/src/services/intents-share-repository.ts`, `services/gateway/src/services/chat-groups-repository.ts`, `services/gateway/src/services/upstream-message-handler-repository.ts`, `services/gateway/src/services/chat-writer-inventory.ts`, `services/gateway/test/mt-network-messaging-send-gateway.test.ts`, `services/gateway/test/mt-network-chat-writer-lint.test.ts`

- [ ] 1 Rewrite `/send` (`chat.ts:54`) to call `send_message()` with a per-request user-JWT client (not service role).
- [ ] 2 Route ORB voice send/share-link, intent share, gateway group send and the ORB live bridge through `send_message_as(req.identity.user_id, …)`.
- [ ] 3 Thread identity `(scope, tenant_id if community, peer)` in the recent-conversations path.
- [ ] 4 Generated writer inventory + lint test: `chat_messages`/`global_messages` inserts only inside the two RPCs plus the system-writer allowlist (`/vitana-reply` `chat.ts:281`, welcome-chat, notification bots), all `scope='community'`.
- [ ] 5 Jest/contract: ORB voice send to a non-`network_visible` member of another tenant refused; intent share to a "nobody" recipient refused.

Acceptance: `npm test` (gateway) green incl. writer lint; `npm run test:support` green; dark behind `mt.network_enabled`.

<!-- lane: network-visibility-db -->
## network-visibility-db — network_visible + connection RPCs (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-v1)

Allowed paths: `supabase/migrations/20261102051***_*.sql`, `supabase/tests/mt-network-visibility-db.pgtap.sql`

- [ ] 1 Add `global_community_profiles.network_visible boolean NOT NULL DEFAULT false` + `network_visible_decided_at` + `messaging_preference` (everyone/connections/nobody, default connections). (v1 table, R1-F5.)
- [ ] 2 BEFORE INSERT/UPDATE trigger forcing `network_visible=false` for `service_bot_accounts`/`notification_test_actors`/`platform_only_accounts` (rules 43–45); backfill existing rows false.
- [ ] 3 Revoke client INSERT/UPDATE on `connection_requests` (v1 table); add SECURITY DEFINER `request_connection()`/`respond_connection()` (caller bound to `auth.uid()`, only recipient sets `accepted`, network request requires `network_visible` + preference ≠ nobody + no block + rate limit, `message` capped and dropped for network).
- [ ] 4 Rollback migration + read-only pre/post checks in the PR; note the platform MIGRATION-QUEUE position in the PR body (queue row is a platform-side follow-up, not this v1 PR).
- [ ] 5 pgTAP: a rule-45 actor cannot be set `network_visible=true`; a self-inserted `accepted` connection fails; a network `request_connection` to a non-`network_visible`/"nobody" recipient fails.

Acceptance: pgTAP green; migration lints; rollback present; queue position noted for the platform follow-up.

<!-- lane: messenger-wiring -->
## messenger-wiring — fix inverted labels, scope wiring, one-time prompt (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-v1)

Allowed paths: `src/pages/Messages.tsx`, `src/hooks/useGlobalMessages.ts`, `src/hooks/useHybridMessages.ts`, `src/hooks/useTenantMessages.ts`, `src/components/messages/**`, `src/components/NewConversationPopup.tsx`, `src/i18n/de/inbox.json`, `src/i18n/en/inbox.json`, `src/hooks/useGlobalMessages.scope.test.ts`, `tests/e2e/staging/mt-network-messenger.staging.spec.ts`, `docs/SCREEN_INVENTORY.md`

- [ ] 1 Replace the inverted `inboxModes` (`Messages.tsx:153-154`) with scope values `community`/`network` + correct DE-first labels; default `community`, remembered per surface.
- [ ] 2 Remove `useHybridMessages` role routing + the legacy `tenant` context; fold the professional channel into community role-gated threads.
- [ ] 3 `useGlobalMessages` thread dedup → `(scope, tenant_id if community, peer)`.
- [ ] 4 One-time network-visibility prompt (recorded golden exception); Spotlight tokens; RTL logical props; i18n DE-first.
- [ ] 5 Vitest for the dedup/scope wiring; read-only staging spec (labels render, prompt shows; network guard aborts non-GET). `npm run i18n:inventory`.

Acceptance: `npx vitest run` green; ESLint (i18n + design) clean on new/changed files; dark behind `mt.network_enabled`.

<!-- lane: legacy-messages-migration-db -->
## legacy-messages-migration-db — migrate & retire legacy message tables (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-v1)

Allowed paths: `supabase/migrations/20261102052***_*.sql`, `supabase/tests/mt-network-legacy-migration.pgtap.sql`

- [ ] 1 Snapshot `bak_messages`/`bak_message_threads`/`bak_global_message_threads`/`bak_global_messages` (retain 30 days). (All source tables are v1, R1-F4.)
- [ ] 2 Freeze + migrate `messages`/`message_threads` into `chat_messages` with `scope` per D15; migrate `global_message_threads`/`global_messages` into `chat_groups` (platform targets in the same Supabase project).
- [ ] 3 Drop the legacy tables; rollback restores from `bak_*`; read-only pre/post row-count checks in the PR; note the platform MIGRATION-QUEUE position in the PR body (platform follow-up).
- [ ] 4 pgTAP on the shared-tenant→community / else→network mapping.

Acceptance: pgTAP green; migration lints; rollback restores exact counts; queue position noted. Depends on messaging-send-db (platform `chat_messages.scope`) and network-visibility-db.

<!-- lane: matching-intent-scope-db -->
## matching-intent-scope-db — daily_matches/intent scope + Vitana Index removal (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-v1)

Allowed paths: `supabase/migrations/20261102053***_*.sql`, `supabase/tests/mt-network-matching-scope.pgtap.sql`

- [ ] 1 Add `daily_matches.scope` (+ tenant context) and backfill per D15, respecting the existing unique key `(tenant_id,user_id,match_date,match_type,target_id)`. (v1 `daily_matches` `20251111124306`, not platform `matches_daily` — R1-F1/F2.)
- [ ] 2 Intent matchers (`compute_intent_matches`, v1 `20260501*`) `p_visibility` default `'public'` → caller scope; `community`→tenant branch, `network`→public restricted to `network_visible`. (`resolve_recipient_candidates` scope lives in `orb-recipient-scope-gateway`.)
- [ ] 3 Remove Vitana Index inputs from matching; `daily_matches.match_reasons` carries no health-derived code (D25); register the v1 recompute (`generate-daily-matches`) + intent matchers in the lineage-guard inventory.
- [ ] 4 Rollback + read-only pre/post checks in the PR; pgTAP + a `match_reasons` no-health-code test; note the platform MIGRATION-QUEUE position in the PR body (platform follow-up).

Acceptance: pgTAP green; migration lints; rollback present; queue position noted. Depends on network-visibility-db.

<!-- lane: orb-recipient-scope-gateway -->
## orb-recipient-scope-gateway — ORB recipient/search scope (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-platform)

Allowed paths: `services/gateway/src/services/orb-tools-shared.ts`, `services/gateway/test/mt-network-orb-scope.test.ts`

- [ ] 1 Pass the scope param to `resolve_recipient_candidates` (`:2054-2061,2278-2282,2431-2435`); default `community`, `network` only on explicit ask, only `network_visible` recipients whose preference allows.
- [ ] 2 Same rule for `find_community_member`, superlatives, `global_search`; enforced in the handler/dispatcher, not the prompt.
- [ ] 3 Dispatcher tests on Nova and the Vertex bridge.

Acceptance: `npm test` (gateway) green; dark behind `mt.network_enabled`. Depends on matching-intent-scope-db (scope param on the RPC).

<!-- lane: matching-discover-scope-v1 -->
## matching-discover-scope-v1 — Find-a-Match/Discover scope wiring (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-v1)

Allowed paths: `supabase/functions/generate-daily-matches/index.ts`, `src/components/match/**`, `src/pages/FindAMatch.tsx`, `src/hooks/useRealMatches.ts`, `src/i18n/de/match.json`, `src/i18n/en/match.json`, `src/hooks/useRealMatches.scope.test.ts`, `tests/e2e/staging/mt-network-find-a-match.staging.spec.ts`

- [ ] 1 Scope the `generate-daily-matches` candidate pool by `daily_matches.scope`; network pool = `network_visible` only; no Vitana Index inputs (D25).
- [ ] 2 Find-a-Match scope control wiring (reuse the messenger/matching scope; separate from the Discover tab pill).
- [ ] 3 Vitest for the scoped pool; read-only staging spec; i18n DE-first; Spotlight on touched screens; `npm run i18n:inventory`.

Acceptance: `npx vitest run` green; ESLint (i18n + design) clean; dark behind `mt.network_enabled`. Depends on matching-intent-scope-db.

<!-- lane: network-groups-db -->
## network-groups-db — chat_groups scope + add_group_member (M3, flagged) (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-platform)

Allowed paths: `supabase/migrations/20261102054***_*.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json`, `services/gateway/test/mt-network-groups-db.pgtap.test.ts`

- [ ] 1 Add `chat_groups.scope`/`chat_group_members.scope`; participant-only RLS for network groups.
- [ ] 2 `add_group_member()` DEFINER: ≤20 members, invite-only between connections, creator tenant as context, no system fan-out.
- [ ] 3 Rollback + pre/post checks; MIGRATION-QUEUE row (LAST); pgTAP on the D27 limits.

Acceptance: pgTAP green; migration lints; queue updated; rollback present. Flagged `mt.network_groups`. Depends on messaging-send-db, legacy-messages-migration-db.

<!-- lane: network-groups-gateway -->
## network-groups-gateway — group create/join via DEFINER (M3, flagged) (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-platform)

Allowed paths: `services/gateway/src/services/chat-groups-repository.ts`, `services/gateway/src/routes/chat-groups.ts`, `services/gateway/test/mt-network-groups-gateway.test.ts`

- [ ] 1 Route network-group create/join through `add_group_member()`; enforce D27 server-side.
- [ ] 2 Jest/contract: a non-connection cannot be added; a 21st member is refused; a system fan-out never targets a network group.

Acceptance: `npm test` (gateway) green; flagged `mt.network_groups`. Depends on network-groups-db.

<!-- lane: network-groups-v1 -->
## network-groups-v1 — network group UI + labels (M3, flagged) (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-v1)

Allowed paths: `src/components/messages/**`, `src/pages/Messages.tsx`, `src/i18n/de/inbox.json`, `src/i18n/en/inbox.json`, `tests/e2e/staging/mt-network-groups.staging.spec.ts`

- [ ] 1 Network-group create/invite UI (invite-only between connections, ≤20), scope label "Netzwerk"; Spotlight tokens; RTL.
- [ ] 2 Vitest for the create/invite flow; read-only staging spec; i18n DE-first; `npm run i18n:inventory`.

Acceptance: `npx vitest run` green; ESLint (i18n + design) clean; flagged `mt.network_groups`. Depends on network-groups-gateway.

## Escalation carry-over (from `mt-network`, session `0f65161a`, rounds 1–2)
Each finding is answered in `plan.md` under "Re-plan answers". The tasks carry the acceptance.
- R1-F1 [blocker], verbatim: "The plan asserts global_community_profiles, connection_requests, daily_matches,
  intent_matches and compute_intent_matches are 'vitana-v1 tables' … and routes their migrations into the vitana-v1
  tree… But the platform repository contains active, LIVE definitions and code for these tables and functions that the
  plan treats as v1-only."
  Lanes: `network-visibility-db`, `legacy-messages-migration-db`, `matching-intent-scope-db`. All three are now
  vitana-platform.
  Acceptance:
  - Every DB change of this spec is in vitana-platform `supabase/migrations`.
  - The function changes start from the `20261005120000` bodies.
  - pgTAP checks that `p_visibility` no longer defaults to `'public'`, and that a rule-45 actor has
    `network_visible = false`. These are red on `origin/main`.
- R1-F4 [major] / R2-F1 [major], verbatim (R2-F1): "R1-F4 was accepted but not actually addressed. R1-F4 flagged that
  chat_groups_service_role and chat_group_members_service_role are USING(true) catch-all policies identical to the
  chat_messages catch-all that messaging-send-db explicitly DROPs."
  Lanes: `network-groups-db`, `network-groups-gateway`, `messaging-send-db`.
  Acceptance:
  - A pgTAP catalog check finds no permissive `FOR ALL USING (true)` policy for `PUBLIC`/`authenticated` on
    `chat_groups`, `chat_group_members` or `chat_messages`. All three were dropped by `20260608120000:25-27`.
  - `add_group_member()` refuses a non-member caller, and refuses a non-connection for a Network group.
  - A Jest lint fails on a `.from('chat_group_members')` write outside the wrapper. It is red on `origin/main`,
    where `routes/chat-groups-repository.ts` writes directly.
- R2-F2 [minor], verbatim: "tool_send_chat_message at orb-tools-shared.ts:2676-2693 performs a direct
  sb.from('chat_messages').insert() that bypasses the chat-repository.ts data-access seam. This is one of at least three
  distinct chat_messages INSERT code paths…"
  Lane: `messaging-send-gateway`.
  Acceptance:
  - `test/mt-network-chat-writer-lint.test.ts` uses the `.from()` regex.
  - On `origin/main` it reports the 11 listed sites (red).
  - On the lane head it reports 0 outside `send_message(_as)` and the allowlisted system writers.

