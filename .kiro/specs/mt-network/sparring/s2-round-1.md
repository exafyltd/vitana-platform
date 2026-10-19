# Sparring round 1 — in_progress

Session: `0f65161a-d135-4939-9671-e3ef24e1d96f` · plan hash `be9ffb9a204ec551bf775ef9bcbf8fff6c66e600de850da06e4c02b5f30bb791`

## Summary

The plan's messenger/messaging-send-db findings are largely accurate: the service-role catch-all policy, unguarded client INSERT, and ORB p_global:true resolution all hold. However, the plan's CORE premise — that global_community_profiles, connection_requests, daily_matches, intent_matches and compute_intent_matches are "vitana-v1 tables" requiring a vitana-v1 migration lane — is contradicted by the platform repository, which contains active definitions, RLS/trigger logic, and gateway code that reads and writes these tables. If the real tables live in the platform DB (one Supabase project), the plan's DB-lane split is wrong and the vitana-v1 migration lane would target tables that do not exist in that migration tree, or would duplicate tables into a second tree. I could not read the vitana-v1 repository (no pinned ref available in this session), so the "v1" claims are unverifiable from this side and are treated as disputed. Several findings are blockers/major.

## Findings

### R1-F1 [blocker]

The plan asserts global_community_profiles, connection_requests, daily_matches, intent_matches and compute_intent_matches are 'vitana-v1 tables' (20250917153624 / 20251111124306 / 20260501*) and routes their migrations into the vitana-v1 tree, with platform tree only containing chat_messages/chat_groups. But the platform repository contains active, LIVE definitions and code for these tables and functions that the plan treats as v1-only.

- `exafyltd/vitana-platform:supabase/migrations/20261005120000_vtid_04888_rule45_intents_profiles.sql:38` — CREATE OR REPLACE FUNCTION public.search_intent_catalog_v2(p_user_id uuid, ... p_visibility text DEFAULT 'public'::text ...) ... SELECT count(*) INTO v_pool_size FROM public.user_intents ui ... AND (ui.tenant_id = p_tenant_id OR p_visibility = 'public');
- `exafyltd/vitana-platform:supabase/migrations/20260618000000_BOOTSTRAP_canonical_people_search.sql:49` — ON public.global_community_profiles USING gin (lower(coalesce(display_name, '')) gin_trgm_ops);
- `exafyltd/vitana-platform:supabase/migrations/20261005120000_vtid_04888_rule45_intents_profiles.sql:1` — Find-a-Match: search_intent_catalog(_v2) and compute_intent_matches(_v2) put the intents ... Member profile lists read global_community_profiles through RLS (is_visible = true) ... intent_matches backstop: any insert pairing an excluded account ... is skipped
- `exafyltd/vitana-platform:services/gateway/src/routes/community-members.ts:15` — Visibility: respects global_community_profiles.is_visible. The default for new signups is true (per existing seed).
- `exafyltd/vitana-platform:services/gateway/src/routes/matchmaking.ts:1` — VTID-01088: Matchmaking Engine v1 (Gateway Routes) ... - POST /recompute/daily - Recompute daily matches ... GET /daily

Suggestion: Re-verify where these tables actually live in the single Supabase project. If global_community_profiles (rule-45 trigger in 20261005120000), compute_intent_matches/search_intent_catalog_v2, daily_matches/intent_matches, and connection_requests are all platform-schema tables (as the platform migrations and gateway code indicate), then the 'network-visibility-db' and 'matching-intent-scope-db' lanes belong in the PLATFORM tree, not the vitana-v1 tree, and the whole DB-lane split (and the 'legacy-messages-migration-db' v1→platform write claim) must be re-derived. Where is the actual CREATE TABLE for global_community_profiles/connection_requests/daily_matches? The plan must cite the exact migration file in the tree where each table is defined before any lane can be approved.

### R1-F2 [major]

Unverifiable premise: the plan depends on the vitana-v1 repository for network-visibility, connection_requests, legacy global_messages/global_message_threads, and the daily/intent matching lanes, but the vitana-v1 repo has no pinned ref in this review session, so none of the v1-side claim refs (20250917153624, 20251111124306, 20260501*, generate-daily-matches Edge Function, 60/379 global_message rows) can be confirmed, and the v1 migration lane cannot be validated against a real schema.

- `exafyltd/vitana-platform:supabase/migrations/20260618000000_BOOTSTRAP_canonical_people_search.sql:9` — resolve_recipient_candidates() built its candidate pool from public.profiles ... global_community_profiles.display_name ... Name search only looked at profiles.display_name. Names also live in app_users.display_name, global_community_profiles.display_name
- `exafyltd/vitana-platform:supabase/migrations/20261005120000_vtid_04888_rule45_intents_profiles.sql:1` — search_intent_catalog(_v2) and compute_intent_matches(_v2) ... Every other line is byte-identical to the live definitions captured in docs/validation/VTID-04888/live-functions-before.sql

Suggestion: Add the vitana-v1 repository to the review's pinned set (it is advertised in the plan but not readable), or re-scope the plan to the single platform Supabase project. Until the v1 schema is verifiable, the legacy-migration mapping, network_visible backfill, and matching-scope lanes cannot be approved as written.

### R1-F3 [major]

The plan drops the catch-all service_role_manage_chat policy and revokes client INSERT on chat_messages, and routes all writes through send_message/send_message_as with an 'allowlist of true system writers' (bot /vitana-reply at chat.ts:281, welcome-chat, notification bots). But /vitana-reply does NOT itself insert into chat_messages directly in chat.ts — it delegates to handleVitanaTextReply()/processConversationTurn(), and the actual chat_messages write for bot replies happens inside the conversation/brain pipeline, not at the line the plan cites. The writer inventory that must be complete BEFORE the revoke is therefore not anchored to verified call sites.

- `exafyltd/vitana-platform:services/gateway/src/routes/chat.ts:281` — router.post('/vitana-reply', ...) ... const result = await handleVitanaTextReply( identity.user_id, identity.tenant_id, trimmedContent, supabase, );
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools-shared.ts:2398` — export async function tool_send_chat_message( args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient, ): Promise<OrbToolResult> {

Suggestion: Before the revoke migration, enumerate every code path that writes chat_messages/global_messages (orb tool_send_chat_message/tool_share_link, conversation/brain pipeline, welcome-chat, notification bots, group send), and cite the exact files/functions. The plan's cited 'bot' writer (chat.ts:281) does not itself insert, so the allowlist needs re-derivation from the actual insert call sites via the generated writer-inventory lint the plan itself promises.

### R1-F4 [major]

The M3 network-groups lanes claim chat_groups/chat_group_members have 'no scope' and need scope columns, but the existing chat_groups table already has tenant_id NOT NULL and a service_role FOR ALL USING(true) catch-all policy (chat_groups_service_role, chat_group_members_service_role) identical in structure to the chat_messages catch-all the rest of the plan is closing. The plan does not address these existing unrestricted service-role policies for group tables in the M3 gate, leaving a parallel tenant-isolation/scope gap untouched.

- `exafyltd/vitana-platform:supabase/migrations/20260525000000_VTID_03089_chat_groups.sql:77` — CREATE POLICY chat_groups_service_role ON public.chat_groups FOR ALL USING (true) WITH CHECK (true); ... CREATE POLICY chat_group_members_service_role ON public.chat_group_members FOR ALL USING (true) WITH CHECK (true);
- `exafyltd/vitana-platform:supabase/migrations/20260525000000_VTID_03089_chat_groups.sql:26` — CREATE TABLE IF NOT EXISTS public.chat_group_members ( group_id ... user_id ... tenant_id UUID NOT NULL, role TEXT ... 'member','admin','bot' ...)

Suggestion: When adding scope to chat_groups/chat_group_members in network-groups-db, also replace the two USING(true) service_role catch-all policies with narrow, participant-only RLS (matching the send-message lane's approach), and add pgTAP asserting a service-role client cannot insert a group-member row into an arbitrary group. Otherwise the D27 invite-only guarantee is bypassable via the existing catch-all.

### R1-F5 [minor]

The plan asserts chat_messages carries 'no scope column' and no request_connection/respond_connection/send_message_as RPC exists — confirmed (search returns only plan-sparring docs, no source definitions). But the messenger.tsx:153-154 inboxModes inversion and useGlobalMessages/useHybridMessages claims in the v1 tree are unverifiable here and the plan marks the fix in the v1/messenger area, leaving the actual inverted-switch defect unverified against any read file in this session.

- `exafyltd/vitana-platform:supabase/migrations/20260225200000_chat_messages.sql:34` — CREATE POLICY "service_role_manage_chat" ON chat_messages FOR ALL USING (true) WITH CHECK (true);
- `exafyltd/vitana-platform:supabase/migrations/20260225200000_chat_messages.sql:6` — CREATE TABLE IF NOT EXISTS chat_messages ( id UUID ... tenant_id UUID NOT NULL, sender_id UUID NOT NULL, receiver_id UUID NOT NULL, content TEXT NOT NULL, read_at TIMESTAMPTZ, created_at ... );

Suggestion: Non-blocking, but the messenger frontend file (src/pages/Messages.tsx) is in the v1 tree which is not readable in this session; confirm the inverted-labels defect with a read of that file before the messenger-wiring lane ships.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
