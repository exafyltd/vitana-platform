# Sparring round 1 — in_progress

Session: `0725552c-f9b6-4000-950d-754ab437858f` · plan hash `0c23b57e7c6779f4ed7bbf46208cbd49194c107a065ad74933be16c26a97f8e0`

## Summary

Verified 12+ premises against the pinned platform commit. The vitana-v1 repo is not pinned in this session, so all v1-specific premises (Messages.tsx labels, connection_requests table definition, daily_matches/intent_matches schemas, generate-daily-matches Edge Function) remain unverifiable — the plan must not proceed without independent v1 verification. Key platform premises about the chat.ts /send route, service-role client, insertChatMessage, the security hotfix policy drops, and the ORB resolve_recipient_candidates p_global:true calls all hold. Two findings concern the writer inventory accuracy.

## Findings

### R1-F1 [major]

The writer inventory lists `services/intent-notifier-repository.ts:35` as a chat_messages insert site, but this file does not appear to exist. A GitHub search for `intent-notifier-repository.ts` returns zero hits; the actual file appears to be `services/intent-notifier.ts` (no `-repository` suffix). Similarly, the search for chat_messages insert in the companion directory points to `services/companion/delivery.ts`, not the listed `services/companion/companion-repository.ts:322`. If the writer lint's allowlist references non-existent or wrong file paths, the lint will either fail spuriously or — worse — silently miss real unguarded insert sites that bypass the `send_message`/`send_message_as` wrappers.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/companion-repository.ts:1` — File exists but could not be read to line 322 before tool cap; GitHub search for 'companion-repository chat_messages insert' pointed at delivery.ts, not companion-repository.ts
- `exafyltd/vitana-platform:services/gateway/src/orb/live/session/upstream-message-handler-repository.ts:33` — return sb.from('chat_messages').insert(row);

Suggestion: Before implementing the writer lint, run a verified `grep -rn ".from('chat_messages')" services/gateway/src/` and `grep -rn ".from('global_messages')" services/gateway/src/` against the pinned commit to produce the ground-truth inventory. Confirm every path in the allowlist matches a real file. In particular, verify whether the companion chat_messages insert lives in `companion-repository.ts` or `delivery.ts`, and whether the intent-notifier insert lives in `intent-notifier.ts` or a `-repository` variant.

### R1-F2 [major]

All premises about vitana-v1 files are unverifiable in this review session because the v1 repo is not pinned. This affects multiple critical claims: (a) Messages.tsx:153-154 inverted inboxModes labels, (b) connection_requests defined in v1 20251111124306:24, (c) global_community_profiles defined in v1 20250917153624:5, (d) daily_matches/intent_matches table schemas in v1, (e) generate-daily-matches Edge Function pooling all tenants. The plan's fix lanes — `network-visibility-db`, `legacy-messages-migration-db`, `matching-intent-scope-db` — all target v1 migrations. If the v1 table schemas, column names, or unique keys don't match what the plan assumes, the migrations will fail or corrupt data.

- `exafyltd/vitana-platform:supabase/migrations/20260225200000_chat_messages.sql:6` — CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  sender_id UUID NOT NULL,
  receiver_id UUID NOT NULL,
  content TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

Suggestion: Pin vitana-v1 at the stated commit (58c76c956) in the review session and re-verify every v1 premise: Messages.tsx inboxModes, connection_requests CREATE TABLE + INSERT policy, global_community_profiles columns, daily_matches unique key, intent_matches schema, and generate-daily-matches/index.ts tenant pooling. Do this before granting VTID.

### R1-F3 [minor]

The plan's fix section for `messaging-send-gateway` references 'bot `/vitana-reply` `chat.ts:281`' as an allowlist entry, but the `/vitana-reply` route starts at line 441. Line 281 is inside the `/send` handler's push-notification block. The corrections section correctly states `/vitana-reply :441`, creating an internal inconsistency.

- `exafyltd/vitana-platform:services/gateway/src/routes/chat.ts:275` — } catch (err: any) {
    console.warn('[Chat] Failed to resolve sender name, falling back to generic:', err?.message);
  }

  // Fire-and-forget push notification to the receiver (not for Vitana bot)
- `exafyltd/vitana-platform:services/gateway/src/routes/chat.ts:441` — router.post('/vitana-reply', requireAuth, requireTenant, async (req: Request, res: Response) => {

Suggestion: Correct the allowlist reference to `chat.ts:441` (the actual `/vitana-reply` route handler) and identify the exact line of the bot's chat_messages insert within that handler for the lint allowlist.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
