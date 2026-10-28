-- VTID-05137: WhatsApp-style chat pushes — one push per conversation per burst.
--
-- The gateway (services/gateway/src/services/chat-push-coalescer.ts) now holds
-- back a chat push when the recipient was pushed for the same conversation in
-- the last 5 minutes and has not read it. The in-app row is still written
-- (push_sent_at set, so /push-dispatch never sends it) and records
-- push_outcome = 'coalesced'.
--
-- 1. push_outcome CHECK gains 'coalesced'. Re-created NOT VALID, then
--    validated (every existing value is already allowed; the scan only takes a
--    SHARE UPDATE EXCLUSIVE lock). Until this is applied the gateway's outcome
--    write for a held-back row fails and is logged — best effort by design
--    (recordPushOutcome) — and data.push_coalesced='true' still marks the row.
-- 2. Partial index for the coalescer's one read per message:
--    user_id = ANY(...) AND type IN (chat types) AND data->>'conversation_key' = $key
--    AND read_at IS NULL AND created_at >= now() - 24h.
--    user_notifications is ~97k rows / 61 MB (2026-10-13), so a plain
--    CREATE INDEX is sub-second.
--
-- Additive and idempotent. Rollback: docs/validation/VTID-05137/rollback.sql.

BEGIN;

ALTER TABLE public.user_notifications
  DROP CONSTRAINT IF EXISTS user_notifications_push_outcome_check;

ALTER TABLE public.user_notifications
  ADD CONSTRAINT user_notifications_push_outcome_check CHECK (
    push_outcome IS NULL OR push_outcome IN (
      'delivered_fcm',
      'delivered_appilix',
      'delivered_both',
      'no_device',
      'fcm_error',
      'suppressed_type_disabled',
      'suppressed_push_disabled',
      'suppressed_dnd',
      'dispatch_exception',
      'coalesced'
    )
  ) NOT VALID;

ALTER TABLE public.user_notifications
  VALIDATE CONSTRAINT user_notifications_push_outcome_check;

CREATE INDEX IF NOT EXISTS idx_user_notifications_chat_conv
  ON public.user_notifications (user_id, ((data ->> 'conversation_key')), created_at DESC)
  WHERE type IN ('new_chat_message', 'chat_mention');

COMMENT ON COLUMN public.user_notifications.push_outcome IS
  'VTID-04962: delivery outcome written by the gateway after the push attempt (best effort). NULL = not recorded. push_sent_at remains the handled marker. VTID-05137: coalesced = chat push held back because the recipient was already pushed for this conversation moments ago.';

COMMIT;
