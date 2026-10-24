# Design — mt-network (WS3 Network layer)

## What exists (read these, do not copy them)
- Program plan & decisions: `docs/MULTI-TENANT-PLAN.md` §4.11 (Community/Network scopes) + §6 WS3; D1, D15, D23, D25, D27.
- Migration order/ranges/status: `docs/multitenancy/MIGRATION-QUEUE.md`.
- Messenger (v1): `src/pages/Messages.tsx:153-154` (`inboxModes` — `global`→"Community", `tenant`→"Network", inverted vs the tenant/network intent); `src/hooks/useGlobalMessages.ts` (reads `chat_messages`, participant-filtered in the browser; thread dedup by peer only); `src/hooks/useHybridMessages.ts` (role routing + legacy `tenant` context over `messages`/`message_threads`); `src/hooks/useTenantMessages.ts` (legacy professional channel); `src/hooks/useGlobalMessages.legacy-threads-error-logging.test.ts`.
- Gateway chat: `services/gateway/src/routes/chat.ts` — service-role client (`:51-54`), `POST /send` (`:58`) writes `tenant_id/sender_id` via `insertChatMessage`, `/vitana-reply` bot writer (`:281`); `services/gateway/src/routes/chat-repository.ts` — `insertChatMessage` (`:20-23`), `insertVitanaReplyMessage` (`:92-94`), the fetch/mark/count helpers.
- ORB recipient resolution: `services/gateway/src/services/orb-tools-shared.ts:2054-2061,2278-2282,2431-2435` (`resolve_recipient_candidates(p_global:true)`), plus `find_community_member`/`global_search`/superlatives in the same file.
- Matching (v1 edge): `supabase/functions/generate-daily-matches/index.ts` (pool = all `is_visible` across tenants; scores on `vitana_index_scores`; `match_reasons`). Intent matchers: the `search_intent_catalog(_v2)`/`compute_intent_matches(_v2)` RPCs (existing `p_visibility` default `'public'`).
- No `send_message`/`send_message_as`/`request_connection`/`respond_connection` RPC exists yet (verified: zero hits in the gateway tree) — all are new.

## Design per lane

### messaging-send-db (platform DB)
Expand/contract add `chat_messages.scope text NOT NULL CHECK (scope IN ('community','network'))` (`DEFAULT 'community'` during the migration, drop the default after backfill). Add `global_community_profiles.messaging_preference text NOT NULL DEFAULT 'connections' CHECK (… IN ('everyone','connections','nobody'))` and a `message_first_contact_log(sender_id, created_at, …)` for the cross-tenant first-contact rate limit (open question — confirm no reuse). Create SECURITY DEFINER `send_message(p_peer uuid, p_group uuid, p_scope text, p_body text, …)`: `sender := auth.uid()`; `community` requires a shared active tenant and derives `tenant_id` from it; `network` requires both members `network_visible`, recipient preference check, no block, rate-limit; INSERTs the row with the derived `tenant_id` (sender's tenant as context) and `scope`. `send_message_as(p_sender, …)` identical body, EXECUTE to `service_role` only, `p_sender` trusted (gateway-verified). `REVOKE INSERT ON chat_messages, global_messages FROM authenticated, anon`. Connection path: `REVOKE INSERT, UPDATE ON connection_requests FROM authenticated, anon`; `request_connection(p_to, p_scope, p_message)` + `respond_connection(p_request, p_accept)` DEFINER, caller `= auth.uid()`, only recipient sets `accepted`, network gates as above, free-text capped and dropped for network. Predicates evaluated once per statement via `(select …)`. Rollback re-grants and drops the functions/columns.

### messaging-send-gateway (gateway code)
Rewrite `/send` (`chat.ts:58`) to call `send_message()` with the **user JWT** (a per-request anon client with the caller's token), not the service-role client. Route gateway member-on-behalf sends through `send_message_as(req.identity.user_id, …)`: ORB voice send/share-link and intent share (`orb-tools-shared.ts`, intent share repo), gateway group send, ORB live bridge. Thread identity `(scope, tenant_id if community, peer)` in the recent-conversations path. Generated writer inventory + lint (a test that greps the build output / AST) allowing `chat_messages`/`global_messages` inserts only inside `send_message`/`send_message_as` plus an allowlist of system writers (`/vitana-reply` bot `chat.ts:281`, welcome-chat, notification bots) that always write `scope='community'`.

### network-visibility-db (platform DB)
Add `global_community_profiles.network_visible boolean NOT NULL DEFAULT false` + `network_visible_decided_at timestamptz`. BEFORE UPDATE/INSERT trigger forces `network_visible=false` when the user is in `service_bot_accounts`/`notification_test_actors`/`platform_only_accounts` (rule 43–45). Backfill all existing rows false. Rollback drops the columns + trigger.

### messenger-wiring (v1, messenger area)
Replace the inverted `inboxModes` (`Messages.tsx:153-154`) with `scope` values `community`/`network` and correct labels (DE first: "Community"/"Netzwerk"); default `community`, remembered per surface. Remove `useHybridMessages` role routing and the legacy `tenant` context; `useTenantMessages` legacy professional channel folded into community role-gated threads. Wire `useGlobalMessages` thread dedup to `(scope, tenant_id if community, peer)`. One-time network-visibility prompt component (recorded Maxina golden exception). i18n shards `src/i18n/de|en/*` for the new strings.

### legacy-messages-migration-db (platform DB)
Snapshot `bak_messages`/`bak_message_threads`/`bak_global_message_threads`/`bak_global_messages` (retain 30 days). Migrate the 12 `messages` / 5 `message_threads` rows into `chat_messages` with `scope` per D15 (shared tenant → community of the shared/primary tenant, else network); freeze `global_messages` read-only, migrate `global_message_threads`/`global_messages` into `chat_groups` (community group if all participants share a tenant, else network group). Drop the legacy tables. Rollback restores from `bak_*`.

### matching-intent-scope-db (platform DB)
Add `daily_matches.scope` (+ tenant context column for community) and backfill per D15. Change the intent matchers' default from `'public'` to the caller-selected scope; map `community`→tenant branch, `network`→public branch restricted to `network_visible`. Add a scope parameter to `resolve_recipient_candidates` (network pool requires `network_visible`). Remove Vitana Index inputs from the matching path and ensure `match_reasons` carries no health-derived code (D25). Register `generate-daily-matches` + the intent matchers in the lineage-guard inventory (mt-guardrails).

### orb-recipient-scope-gateway (gateway code)
Pass the new scope parameter from the ORB tools (`orb-tools-shared.ts:2054-2061,2278-2282,2431-2435`) — default `community`, `network` only on explicit member request; same rule for `find_community_member`, superlatives, `global_search`. Enforced in the handler/dispatcher (not the prompt). Dispatcher tests on Nova and the Vertex bridge.

### matching-discover-scope-v1 (v1 code)
Discover/Find-a-Match scope control wiring (reuse the scope the messenger/matching surfaces set; separate from Discover's existing tab pill) and the `generate-daily-matches` scoped pool call. Spotlight contract on any touched screen.

### network-groups-db / -gateway / -v1 (M3, flagged `mt.network_groups`)
`chat_groups.scope`/`chat_group_members.scope` + participant-only RLS; `add_group_member()` DEFINER (≤20, invite-only between connections, creator tenant as context, no system fan-out). Gateway group create/join routed through the DEFINER function; v1 group create/join UI + labels. LAST lanes; mt-network owns them.

## Rules every successor follows
1. **Migrations** apply strictly in `MIGRATION-QUEUE.md` order, one `RUN-MIGRATION.yml` dispatch per file, by Claude only, with read-only pre/post checks; a new multi-tenant migration takes the next version in the lane's range (`20261101050000`–`20261101055959`) and is added to the queue in the same PR; a not-yet-live table is added to `scripts/ci/migration-drift-baseline.json` and removed after apply.
2. **Dark by default** behind `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.network_enabled` (`mt.network_groups` for the group lanes); no exception in this spec except the one-time network-visibility prompt (D23, recorded golden exception).
3. **No client writes to `chat_messages`/`global_messages`/`connection_requests`** after the revoke migration — only the DEFINER RPCs and the allowlisted system writers; the writer inventory/lint guards it.
4. **No health-derived data in matching** (`match_reasons`) or in any network-visible profile field (D25; lineage guard).
5. **Production is read-only** for every session and test (rules 31–32, 48); the executor never writes to Supabase or AWS (collaboration §7a); a DB change is a migration file in the lane's PR.
6. Test/service/platform-only accounts never visible in either scope (rules 43–45); i18n DE-first du-form; RTL logical properties; Spotlight; WCAG 2.2 AA; `npm run test:support` (42c) green.
