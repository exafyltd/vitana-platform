-- VTID-05310 (messenger-ux-v2/api-send-reliability): idempotent chat sends and delivery state.
--
-- 1. chat_messages.client_message_id — a UUID the client generates per send. A repeat POST with the same
--    (sender_id, client_message_id) returns the stored row instead of inserting a second one (retry after a
--    timeout, a reconnect flush, the gateway-failure fallback insert). Partial unique index: rows written
--    without it (every row today, the bot, server-side writers) are unaffected.
-- 2. chat_messages.delivered_at — set by POST /api/v1/chat/delivered when the recipient's client has the DM,
--    and by POST /chat/read when still NULL. DMs only; group read state stays chat_group_members.last_read_at.
--
-- Both columns are nullable with no default, so ADD COLUMN is metadata-only. chat_messages is ~53k rows /
-- 62 MB (read-only count 2026-10-21). The partial unique index is built inside the transaction (not
-- CONCURRENTLY): it holds a SHARE lock, which blocks inserts, while it scans the table once — expected well
-- under a few seconds at this size; it indexes no rows yet (every client_message_id is NULL).
-- The gateway works with or without this migration: it retries a send without client_message_id when the
-- column is missing (PostgREST PGRST204), and /delivered answers updated: 0.
--
-- Additive and idempotent. Rollback: docs/validation/VTID-05310/rollback.sql.

BEGIN;

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS client_message_id uuid NULL,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_messages_sender_client_message_id
  ON public.chat_messages (sender_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

COMMENT ON COLUMN public.chat_messages.client_message_id IS
  'VTID-05310: client-generated id of one send; (sender_id, client_message_id) is unique, so a retried send returns the stored row.';
COMMENT ON COLUMN public.chat_messages.delivered_at IS
  'VTID-05310: when the recipient''s client received this DM (POST /chat/delivered, or /chat/read). NULL for group messages.';

COMMIT;
