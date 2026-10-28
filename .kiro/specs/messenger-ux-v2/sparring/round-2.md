# Sparring round 2 — in_progress

Session: `9237de82-2618-4566-8bc7-1eefa33ac326` · plan hash `1931a38fc1d56f904551743ae28c79689d631883aab54bd16c9e3c2004ac3906`

## Summary

The three round-1 findings are all genuinely accepted and the revised plan concretely addresses each: R1-F2 (id-based swap → reconcileByClientId, fallback insert carries client_message_id), R1-F3 (group threads never call /chat/delivered), R1-F4 (chat_viewing_presence gains tenant_id). I verified the relevant call sites in code. One new material gap remains: the plan declares new push_outcome values `suppressed_viewing` and `suppressed_duplicate`, but the DB CHECK constraint `user_notifications_push_outcome_check` hard-codes the allowed list and does not include them, and no lane's migration list extends it. Per the VTID-05137 precedent, each new outcome value requires dropping/recreating (and re-validating) that CHECK; without it the outcomes silently fail to persist (recordPushOutcome is best-effort and only logs), breaking the declared audit/observability. Severity major.

## Findings

### R2-F1 [major]

The plan writes push_outcome values 'suppressed_viewing' (I4, viewing suppression) and 'suppressed_duplicate' (duplicate-rows defensive rule) and reasons about them via wasPushed()'s `!outcome.startsWith('suppressed_')` filter. But the DB CHECK constraint `user_notifications_push_outcome_check` hard-codes the allowed set and does not include either value, and no lane's migration list extends it. recordPushOutcome writes the value directly to the column and swallows the error, so `suppressed_viewing`/`suppressed_duplicate` will always violate the CHECK and be silently dropped from the DB (push_sent_at is still set, so suppression itself works, but the declared outcome is never persisted). The VTID-05137 migration (20261013180000_vtid_05137_chat_push_coalescing.sql) is the exact precedent: adding 'coalesced' required dropping and re-adding the CHECK NOT VALID then validating.

- `exafyltd/vitana-platform:supabase/migrations/20261007190000_vtid_04962_user_notifications_push_outcome.sql:28` — ADD CONSTRAINT user_notifications_push_outcome_check CHECK (push_outcome IS NULL OR push_outcome IN ('delivered_fcm','delivered_appilix','delivered_both','no_device','fcm_error','suppressed_type_disabled','suppressed_push_disabled','suppressed_dnd','dispatch_exception')) NOT VALID;
- `exafyltd/vitana-platform:supabase/migrations/20261013180000_vtid_05137_chat_push_coalescing.sql:24` — ADD CONSTRAINT user_notifications_push_outcome_check CHECK (push_outcome IS NULL OR push_outcome IN (..., 'coalesced')) NOT VALID;
- `exafyltd/vitana-platform:services/gateway/src/services/notification-service.ts:303` — const { error } = await repo.setNotificationPushOutcome(supabase, notificationId, outcome); if (error) console.warn(...) // best effort
- `exafyltd/vitana-platform:services/gateway/src/services/chat-push-coalescer.ts:72` — return outcome !== 'coalesced' && !outcome.startsWith('suppressed_');

Suggestion: Add to lane 2 (api-viewing-presence) a migration that drops and recreates user_notifications_push_outcome_check adding 'suppressed_viewing' and 'suppressed_duplicate' (NOT VALID then VALIDATE, same as VTID-05137), and list it in §5/filies. Also add a test asserting the outcome value actually persists (not merely that no 500 is returned), since recordPushOutcome is best-effort.

## Acknowledgements of earlier responses

- R1-F2: acknowledged — I7 now names reconcileByClientId matching temp-<client_message_id> or client_message_id, and the fallback insert carries client_message_id. Confirmed the migrated sites match the code (useGlobalMessages.ts:1284-1286 id swap and the group swap at GroupChat.tsx:337).
- R1-F3: acknowledged — I7 now scopes /chat/delivered to DM rows (receiver_id = me) and group threads never call it, with an acceptance test. Confirmed group send path exists separately (GroupChat.tsx).
- R1-F4: acknowledged — chat_viewing_presence gains tenant_id = identity.tenant_id in I4, tenant-scoped for cleanup and matched against the push tenant. Reasonable and addresses the gap.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
