-- VTID-05576 rollback of 20261102050000 (run last, after rollback-050100 and rollback-050200). Drops the guard trigger, its
-- function, the CHECK and the scope column. REFUSES (changes nothing) while any message has scope = 'network': dropping the column
-- would turn those cross-tenant messages into ordinary tenant messages.
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $rb$
BEGIN
  IF to_regclass('public.chat_messages') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chat_messages' AND column_name = 'scope')
     AND EXISTS (SELECT 1 FROM public.chat_messages WHERE scope = 'network') THEN
    RAISE EXCEPTION 'VTID-05576 rollback refused: network messages exist; move or archive them first' USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public.send_message(uuid,uuid,text,text,text,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05576 rollback refused: roll back 050100 (the RPCs) first' USING ERRCODE = 'P0001';
  END IF;
END
$rb$;
DROP TRIGGER IF EXISTS trg_chat_messages_scope_guard ON public.chat_messages;
DROP FUNCTION IF EXISTS public.chat_messages_scope_guard();
ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_scope_check;
ALTER TABLE public.chat_messages DROP COLUMN IF EXISTS scope;
COMMIT;
