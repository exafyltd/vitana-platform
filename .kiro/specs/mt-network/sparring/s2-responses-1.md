# Planner responses — s2 round 1

Session `c7a55d62-8a16-4430-b42e-eb042bf28f7a`. The partner reviewed with real file:line evidence and surfaced a systemic repo-placement error. I verified every finding against current `origin/main` in **both** repos (the partner saw only the pinned vitana-platform commit, which is the root of F1/F2/F5's "nonexistent" framing). All five accepted; the plan, lanes, tasks and handoff were updated accordingly.

Table-location facts verified today (both repos, `origin/main`):
- `matches_daily` — vitana-platform `supabase/migrations/20251231000001_vtid_01088_matchmaking_engine.sql:127` (the matchmaking-engine; `reasons` col; unique `(tenant_id,user_id,match_date,match_type,target_id)`).
- `daily_matches` (+ `match_reasons` jsonb) — **vitana-v1** `supabase/migrations/20251111124306_...sql:2`; written by **vitana-v1** `supabase/functions/generate-daily-matches/index.ts:150,291,297` (reads `global_community_profiles:111`, `vitana_index_scores:181`).
- `intent_matches` / `compute_intent_matches` — **vitana-v1** `supabase/migrations/20260501000200_intent_matches.sql`, `20260501000400_compute_intent_matches_fn.sql`.
- `service_role_manage_chat` — vitana-platform `supabase/migrations/20260225200000_chat_messages.sql:35-36` (`FOR ALL USING(true) WITH CHECK(true)`).
- `global_messages`/`global_message_threads` — **vitana-v1** `supabase/migrations/20250917153624_...sql:42/:19`.
- `messages`/`message_threads` — **vitana-v1** `supabase/migrations/20250917143525_...sql`.
- `connection_requests` — **vitana-v1** `supabase/migrations/20251111124306_...sql:24` (the only platform social table is `social_connections`, `20260327000000`).
- `chat_messages`/`chat_groups` — vitana-platform `20260225200000`/`20260525000000`.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Confirmed vitana-platform has matches_daily (20251231000001_vtid_01088_matchmaking_engine.sql:127) with a reasons column and unique key (tenant_id,user_id,match_date,match_type,target_id). But this spec targets the DIFFERENT vitana-v1 daily_matches table (20251111124306_...sql:2) with a match_reasons jsonb column, written by the v1 generate-daily-matches Edge Function. Fix: Problem #5 now states explicitly this is the v1 daily_matches/intent system (not platform matches_daily), the matching-intent-scope-db lane is reassigned to vitana-v1, and task 1 respects the existing unique key. The plan does not touch matches_daily.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Correct that no generate-daily-matches Edge Function exists in vitana-platform. It exists in vitana-v1 at supabase/functions/generate-daily-matches/index.ts (verified: reads global_community_profiles:111, vitana_index_scores:181; writes daily_matches:150,291,297). The partner's pin had no v1 ref (its own F5). The plan's references were always to the v1 function; I made that explicit and reassigned the matching DB lane to vitana-v1. The nightly recompute stays the v1 Edge Function + the v1 intent matchers (compute_intent_matches); no platform match_recompute_daily is involved.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Confirmed chat_messages carries catch-all service_role_manage_chat FOR ALL USING(true) WITH CHECK(true) at supabase/migrations/20260225200000_chat_messages.sql:35-36. Revoking only the authenticated INSERT leaves the service-role direct-insert path open, so DB-level scope enforcement would not hold. Fix: messaging-send-db now DROPs service_role_manage_chat and replaces it with narrow SELECT + read_at-UPDATE policies; SECURITY DEFINER send_message()/send_message_as() run as owner and bypass RLS for INSERT, so service-role no longer needs an INSERT policy. Added a pgTAP that a direct service-role INSERT fails after the drop. Updated Problem #2, the fix lane and tasks.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Confirmed global_message_threads/global_messages (vitana-v1 20250917153624_...sql:19/:42) and messages/message_threads (vitana-v1 20250917143525_...sql) are all vitana-v1 tables; vitana-platform has none of them. A platform migration cannot run DDL/DML against them. Fix: legacy-messages-migration-db reassigned to vitana-v1 (seat exafyltd, reviewer hotmail); the chat_messages/chat_groups targets are platform tables in the same single Supabase project, so the v1 migration writes those already-created rows. Dropped the platform-only MIGRATION-QUEUE/drift-baseline/gateway-test paths (v1 has none); pgTAP now supabase/tests/; the platform queue row becomes a platform-side follow-up noted in the PR body.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "connection_requests is a vitana-v1 table (20251111124306_...sql:24); the only platform social table is social_connections (20260327000000). I verified the vitana-v1 messenger premises directly at vitana-v1 origin/main: Messages.tsx inboxModes {value:'global','Community'}/{value:'tenant','Network'} at src/pages/Messages.tsx:152-154 (Problem #1 holds). Fix: the connection_requests RPCs/revokes moved out of messaging-send-db into network-visibility-db (also a v1 table, same v1 migration), and global_community_profiles.network_visible is v1 so network-visibility-db is reassigned to vitana-v1. messaging-send-db now depends on network-visibility-db because send_message's network branch reads network_visible/messaging_preference/connection_requests. The pinned-v1-ref gap is a PLAN-SPAR harness limitation (it pins only vitana-platform); the premises are verified in this response against vitana-v1 origin/main.",
    "deferred_to": null
  }
]
```
