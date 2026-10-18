# Sparring round 1 — in_progress

Session: `c7a55d62-8a16-4430-b42e-eb042bf28f7a` · plan hash `d96559e19b2be6ae3dae672e802b2ae0b62d95a1c4829392f49f62ccbf0458d9`

## Summary

Three premises about the existing system are demonstrably false at the pinned commit: the daily matches table is misnamed throughout, the generate-daily-matches Edge Function does not exist, and an unaddressed catch-all service-role RLS policy defeats DB-level scope enforcement. Two further findings cover unverifiable global_messages ownership and the absence of a pinned vitana-v1 ref for the messenger-wiring premises. The security problems described are real; the implementation targets are partly wrong.

## Findings

### R1-F1 [blocker]

The plan consistently names the target table `daily_matches` (Problem #5 and the matching-intent-scope-db fix lane). The actual table created by the matchmaking-engine migration is `matches_daily`. Every ALTER TABLE and backfill statement in the matching-intent-scope-db lane will fail with relation-not-found.

- `exafyltd/vitana-platform:supabase/migrations/20251231000001_vtid_01088_matchmaking_engine.sql:124` — -- B. matches_daily: Computed match output per user per day
CREATE TABLE IF NOT EXISTS public.matches_daily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    match_date DATE NOT NULL,
    match_type match_target_type NOT NULL,
    target_id UUID NOT NULL REFERENCES public.match_targets(id) ON DELETE CASCADE,
    score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
    reasons JSONB NOT NULL DEFAULT '{}'::JSONB,
    state match_state NOT NULL DEFAULT 'suggested',
    state_changed_at TIMESTAMPTZ,
    rule_version TEXT NOT NULL DEFAULT 'v1',
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT matches_daily_unique UNIQUE (tenant_id, user_id, match_date, match_type, target_id)
);
- `exafyltd/vitana-platform:services/gateway/src/routes/matchmaking-repository.ts:38` — export async function fetchUsersWithSuggestedMatches(sb: SupabaseClient, matchDate: unknown, minScore: unknown) {
  return sb.from('matches_daily').select('user_id').eq('match_date', matchDate).eq('state', 'suggested').gte('score', minScore);
}

Suggestion: Replace every occurrence of `daily_matches` in the plan with `matches_daily`. Also note the JSONB column is `reasons`, not `match_reasons`, and the unique constraint includes `match_type` and `target_id` — the scoped backfill must not violate it.

### R1-F2 [blocker]

The plan states the nightly recompute runs in `supabase/functions/generate-daily-matches/index.ts` and targets it for modification. That directory contains only `og-match` and `request-account-deletion`. No generate-daily-matches Edge Function exists. Daily recompute is invoked via the `match_recompute_daily` SQL RPC called from the gateway. The matching-intent-scope-db and matching-discover-scope-v1 lanes are targeting a nonexistent file.

- `exafyltd/vitana-platform:services/gateway/src/services/intent-find-match.ts:1` — /**
 * BOOTSTRAP-FIND-MATCH-VOICE — "find me a match" voice capability.
 *
 * runFindMatch implements the search-first contract the user asked for:
 *   1. classify + extract + embed the spoken request,
 *   2. SEARCH the live catalog (search_intent_catalog RPC, read-only),
 *   3a. matches found  → recommend them AND post the request too
 *   3b. no match yet   → read the summary back and, on explicit confirmation, post the request
 */
- `exafyltd/vitana-platform:services/gateway/src/routes/matchmaking-repository.ts:18` — export async function recomputeDailyMatchesRpc(sb: SupabaseClient, matchDate: unknown) {
  return sb.rpc('match_recompute_daily', { p_user_id: null, p_date: matchDate });
}

Suggestion: Re-target the scope-pool change at the `match_recompute_daily` SQL function body and at `compute_intent_matches` / `search_intent_catalog` RPCs in the migrations tree. Update lane descriptions, lineage-guard join point, and pgTAP test paths to reference those SQL functions.

### R1-F3 [major]

The chat_messages table has a `service_role_manage_chat` RLS policy (`FOR ALL USING (true) WITH CHECK (true)`). The messaging-send-db lane revokes the `users_send_messages` authenticated INSERT policy, but never mentions dropping or narrowing this catch-all. After the change any code holding a service-role client — including `getSupabase()` + `repo.insertChatMessage()` after a regression — can still write arbitrary scope and tenant_id, bypassing `send_message()`. DB-level scope enforcement is not achieved for the service-role path.

- `exafyltd/vitana-platform:supabase/migrations/20260225200000_chat_messages.sql:34` — -- Service-role policy for gateway to insert on behalf of users
CREATE POLICY "service_role_manage_chat"
  ON chat_messages FOR ALL
  USING (true)
  WITH CHECK (true);
- `exafyltd/vitana-platform:services/gateway/src/routes/chat.ts:49` — function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE!
  );
}

Suggestion: The messaging-send-db lane must DROP `service_role_manage_chat` and replace it with narrower policies. SECURITY DEFINER RPCs run as their owner and bypass RLS on their own; only non-INSERT service-role operations (SELECT, UPDATE of read_at) still need a policy. Without this, the writer-inventory lint is the sole enforcement against service-role direct inserts — a code-level control, not a DB guarantee.

### R1-F4 [major]

The legacy-messages-migration-db lane revokes client INSERT on `global_messages`, migrates 60 `global_message_threads` and 379 `global_messages` rows, and freezes both tables — all attributed to the vitana-platform DB (hotmail owner). The only messaging DDL migrations in vitana-platform create `chat_messages` and `chat_groups`; neither file creates `global_messages` or `global_message_threads`. DATABASE_SCHEMA.md explicitly notes that some tables are defined in the vitana-v1 migration tree. If these tables live in vitana-v1, a vitana-platform migration cannot execute DDL against them.

- `exafyltd/vitana-platform:supabase/migrations/20260225200000_chat_messages.sql:1` — -- Chat Messages — User-to-user direct messaging
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  sender_id UUID NOT NULL,
  receiver_id UUID NOT NULL,
  content TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
- `exafyltd/vitana-platform:DATABASE_SCHEMA.md:167` — ### notification_test_actors
**Purpose:** Accounts whose actions must never notify a real community member (VTID-03506)
...
- Defined in `exafyltd/vitana-v1` migration `20260805160000_vtid_03506_suppress_test_actor_notifications.sql`

Suggestion: Before implementation run `SELECT to_regclass('public.global_messages'), to_regclass('public.global_message_threads')` on both Supabase projects. If these tables are in vitana-v1, reassign the legacy-messages-migration-db lane to the exafyltd/vitana-v1 owner. If neither project has them, remove the revoke and freeze steps entirely.

### R1-F5 [minor]

vitana-v1 has no pinned ref in this review session. The plan's Problem #1 premises (Messages.tsx:153-154 inboxModes, useHybridMessages role routing, useGlobalMessages thread dedup) and Problem #3 (connection_requests RLS `from_user_id = auth.uid()`, client-writable status) are unverifiable at the pinned commit. The only social-connectivity migration found in vitana-platform (`vtid_01250_social_connections.sql`) creates `social_connections`, `social_share_prefs`, and `social_share_log` — not `connection_requests`. If connection_requests is a vitana-v1 table, the platform DB revoke and RPC-creation steps cannot touch it.

- `exafyltd/vitana-platform:supabase/migrations/20260327000000_vtid_01250_social_connections.sql:1` — -- Social Connections for Profile Enrichment
CREATE TABLE IF NOT EXISTS social_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN (
    'instagram', 'facebook', 'tiktok', 'youtube', 'linkedin', 'twitter'
  )),
  ...
- `exafyltd/vitana-platform:DATABASE_SCHEMA.md:167` — ### notification_test_actors
...
- Defined in `exafyltd/vitana-v1` migration `20260805160000_vtid_03506_suppress_test_actor_notifications.sql`

Suggestion: Attach a pinned commit hash for vitana-v1 to the plan. Re-verify Messages.tsx line numbers, useHybridMessages existence, and the exact RLS policy body on connection_requests at that commit before the messenger-wiring and connection_requests lanes are implemented.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
