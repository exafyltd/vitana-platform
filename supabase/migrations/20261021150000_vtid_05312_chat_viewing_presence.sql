-- VTID-05312 (messenger-ux-v2/api-viewing-presence): no chat push for the conversation the recipient views.
--
-- 1. chat_viewing_presence — one row per (member, device/tab) while a conversation is open, visible and
--    focused; written by POST /api/v1/chat/viewing every 20 s, each row lives 45 s (expires_at). The gateway
--    (service role) is the only reader/writer: RLS is on and there are no client policies. tenant_id is
--    required: a push is only suppressed by a presence row of the push's own tenant. Expired rows of a
--    member are deleted on that member's next write.
-- 2. user_notifications.push_outcome CHECK gains 'suppressed_viewing' (the recipient was viewing that
--    conversation) and 'suppressed_duplicate' (a second row for the same recipient and chat message).
--    Re-created NOT VALID, then validated in the same transaction, so the ACCESS EXCLUSIVE lock of the
--    DROP/ADD is held through the validation scan (sub-second at ~100k rows; same pattern and cost as
--    20261013180000_vtid_05137_chat_push_coalescing.sql). Every existing value stays allowed.
-- Order: the table and the widened CHECK land in ONE transaction. Before this migration the presence read
--    fails (no table) and fails open, so nothing is ever suppressed for viewing — no suppressed_viewing row
--    can be written against the old CHECK. Only the dedup outcome 'suppressed_duplicate' can hit the old
--    CHECK: in notifyUser the whole UPDATE is rejected (logged) and the other row stays unpushed, then the
--    /push-dispatch cron finds its pushed sibling and marks it handled on the next tick (push_sent_at is
--    written before the outcome there), so it is still never pushed twice.
--
-- Additive and idempotent. Rollback: docs/validation/VTID-05312/rollback.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS public.chat_viewing_presence (
  user_id          uuid        NOT NULL,
  device_id        text        NOT NULL,
  tenant_id        uuid        NOT NULL,
  conversation_key text        NOT NULL CHECK (conversation_key ~ '^(dm|group):[0-9a-f-]{36}$'),
  expires_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_viewing_presence_lookup
  ON public.chat_viewing_presence (user_id, conversation_key, expires_at);

ALTER TABLE public.chat_viewing_presence ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.chat_viewing_presence IS
  'VTID-05312: which conversation a member is looking at, per device/tab (45 s heartbeat rows). Gateway only (RLS, no policies). Chat pushes for a viewed conversation are suppressed.';

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
      'coalesced',
      'suppressed_viewing',
      'suppressed_duplicate'
    )
  ) NOT VALID;

ALTER TABLE public.user_notifications
  VALIDATE CONSTRAINT user_notifications_push_outcome_check;

COMMIT;
