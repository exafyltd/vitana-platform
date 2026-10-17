# Tasks — mt-network (WS3 Network layer)

Authoritative plan: `plan.md`. Lane files: `lanes/`. VTID: allocated by PLAN-SPAR after approval.

<!-- lane: messaging-send-db -->
## messaging-send-db — scope column, send/connection RPCs, client-write revokes (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-platform)

Allowed paths: `supabase/migrations/20261101050***_*.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json`, `services/gateway/test/mt-network-messaging-send-db.pgtap.test.ts`

- [ ] 1 Expand/contract migration: add `chat_messages.scope` CHECK `('community','network')`, `DEFAULT 'community'`, backfill, drop default; add `global_community_profiles.messaging_preference` + `message_first_contact_log`.
- [ ] 2 `send_message()` / `send_message_as()` SECURITY DEFINER with the §4.11 community/network checks; `send_message_as` EXECUTE to `service_role` only.
- [ ] 3 Revoke client INSERT on `chat_messages`/`global_messages`; revoke client INSERT/UPDATE on `connection_requests`; add `request_connection()`/`respond_connection()`.
- [ ] 4 Rollback migration under `docs/validation/<vtid>/` + read-only pre/post checks; MIGRATION-QUEUE rows in position; drift-baseline entries for not-yet-live objects.
- [ ] 5 pgTAP: bare client INSERT fails; self-inserted `accepted` fails; network send/request to a "nobody" or non-`network_visible` recipient fails; community send without a shared tenant fails.

Acceptance: pgTAP green locally; migration files lint; MIGRATION-QUEUE updated in the same PR; rollback present. Kiro never applies the migration — Claude applies via RUN-MIGRATION after merge.

<!-- lane: messaging-send-gateway -->
## messaging-send-gateway — route sends through the RPCs + writer lint (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-platform)

Allowed paths: `services/gateway/src/routes/chat.ts`, `services/gateway/src/routes/chat-repository.ts`, `services/gateway/src/services/orb-tools-shared.ts`, `services/gateway/src/services/intents-share-repository.ts`, `services/gateway/src/services/chat-groups-repository.ts`, `services/gateway/src/services/upstream-message-handler-repository.ts`, `services/gateway/src/services/chat-writer-inventory.ts`, `services/gateway/test/mt-network-messaging-send-gateway.test.ts`, `services/gateway/test/mt-network-chat-writer-lint.test.ts`

- [ ] 1 Rewrite `/send` (`chat.ts:58`) to call `send_message()` with a per-request user-JWT client (not service role).
- [ ] 2 Route ORB voice send/share-link, intent share, gateway group send and the ORB live bridge through `send_message_as(req.identity.user_id, …)`.
- [ ] 3 Thread identity `(scope, tenant_id if community, peer)` in the recent-conversations path.
- [ ] 4 Generated writer inventory + lint test: `chat_messages`/`global_messages` inserts only inside the two RPCs plus the system-writer allowlist (`/vitana-reply` `chat.ts:281`, welcome-chat, notification bots), all `scope='community'`.
- [ ] 5 Jest/contract: ORB voice send to a non-`network_visible` member of another tenant refused; intent share to a "nobody" recipient refused.

Acceptance: `npm test` (gateway) green incl. writer lint; `npm run test:support` green; dark behind `mt.network_enabled`.

<!-- lane: network-visibility-db -->
## network-visibility-db — network_visible column + rule-45 trigger (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-platform)

Allowed paths: `supabase/migrations/20261101051***_*.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json`, `services/gateway/test/mt-network-visibility-db.pgtap.test.ts`

- [ ] 1 Add `global_community_profiles.network_visible boolean NOT NULL DEFAULT false` + `network_visible_decided_at`.
- [ ] 2 BEFORE INSERT/UPDATE trigger forcing `network_visible=false` for `service_bot_accounts`/`notification_test_actors`/`platform_only_accounts` (rules 43–45).
- [ ] 3 Backfill existing rows false; rollback migration + pre/post checks; MIGRATION-QUEUE row.
- [ ] 4 pgTAP: a rule-45 actor cannot be set `network_visible=true`.

Acceptance: pgTAP green; migration lints; queue updated; rollback present.

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
## legacy-messages-migration-db — migrate & retire legacy message tables (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-platform)

Allowed paths: `supabase/migrations/20261101052***_*.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json`, `services/gateway/test/mt-network-legacy-migration.pgtap.test.ts`

- [ ] 1 Snapshot `bak_messages`/`bak_message_threads`/`bak_global_message_threads`/`bak_global_messages` (retain 30 days).
- [ ] 2 Migrate `messages`/`message_threads` into `chat_messages` with `scope` per D15; freeze + migrate `global_message_threads`/`global_messages` into `chat_groups`.
- [ ] 3 Drop the legacy tables; rollback restores from `bak_*`; pre/post row-count checks; MIGRATION-QUEUE row.
- [ ] 4 pgTAP on the shared-tenant→community / else→network mapping.

Acceptance: pgTAP green; migration lints; queue updated; rollback restores exact counts. Depends on messaging-send-db (scope column) and network-visibility-db.

<!-- lane: matching-intent-scope-db -->
## matching-intent-scope-db — daily_matches/intent scope + Vitana Index removal (VTID: allocated by PLAN-SPAR, Kiro, repo vitana-platform)

Allowed paths: `supabase/migrations/20261101053***_*.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json`, `services/gateway/test/mt-network-matching-scope.pgtap.test.ts`

- [ ] 1 Add `daily_matches.scope` (+ tenant context) and backfill per D15.
- [ ] 2 Intent matchers default `'public'` → caller scope; `community`→tenant branch, `network`→public restricted to `network_visible`; add a scope param to `resolve_recipient_candidates`.
- [ ] 3 Remove Vitana Index inputs from matching; `match_reasons` carries no health-derived code (D25); register the matchers in the lineage-guard inventory.
- [ ] 4 Rollback + pre/post checks; MIGRATION-QUEUE row; pgTAP + a `match_reasons` no-health-code test.

Acceptance: pgTAP green; migration lints; queue updated; rollback present. Depends on network-visibility-db.

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

Allowed paths: `supabase/migrations/20261101054***_*.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json`, `services/gateway/test/mt-network-groups-db.pgtap.test.ts`

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
