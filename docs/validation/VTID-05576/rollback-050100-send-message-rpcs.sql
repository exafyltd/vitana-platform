-- VTID-05576 rollback of 20261102050100 (run after rollback-050200). Drops the two RPCs and the shared core. Idempotent.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.send_message(uuid, uuid, text, text, text, jsonb, uuid);
DROP FUNCTION IF EXISTS public.send_message_as(uuid, uuid, uuid, text, text, text, jsonb, uuid);
DROP FUNCTION IF EXISTS public.chat_send_message_core(uuid, uuid, uuid, text, text, text, jsonb, uuid);
COMMIT;
