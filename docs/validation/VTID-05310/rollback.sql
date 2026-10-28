-- VTID-05310 rollback (only if the gateway change is reverted first; the gateway tolerates the columns either way).
BEGIN;
DROP INDEX IF EXISTS public.uq_chat_messages_sender_client_message_id;
ALTER TABLE public.chat_messages DROP COLUMN IF EXISTS client_message_id, DROP COLUMN IF EXISTS delivered_at;
COMMIT;
