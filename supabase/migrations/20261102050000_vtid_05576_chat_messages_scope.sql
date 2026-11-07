-- VTID-05576 (mt-network-r2/messaging-send-db) N1, expand: chat_messages.scope ('community' | 'network').
--
-- Today a chat_messages row has no scope: every row is a tenant-context message (tenant_id NOT NULL). The Network layer
-- (docs/MULTI-TENANT-PLAN.md section 4.11) adds a second kind, a message between two members who share no tenant but both
-- opted in. This file is the EXPAND half of expand/contract:
--   1. ADD COLUMN scope text NOT NULL DEFAULT 'community' (a constant default: metadata only on PG11+, no table rewrite)
--      with CHECK (scope IN ('community','network')).
--   2. Backfill: every existing row is a community message. The ADD COLUMN default already did it; the guarded UPDATE only
--      repairs a NULL, which cannot exist. (Cross-tenant legacy rows are classified by legacy-messages-migration-db, not here.)
--   3. A BEFORE INSERT / UPDATE OF scope trigger: scope = 'network' is written only by the send RPCs (next file), which set the
--      transaction-local flag vitana.chat_send_rpc = 'on'. A direct write of 'network' by anyone else (service_role included)
--      fails 42501, and an existing row's scope cannot be changed outside the RPCs. A NULL scope falls through to NOT NULL.
-- The DEFAULT is still in place after this file, so the current gateway writers (which send no scope) keep working.
-- The CONTRACT half (drop the default, narrow the policies, revoke client INSERT) is 20261102050200, applied only after the
-- gateway writers send scope = 'community' explicitly (lane messaging-send-gateway).
-- Dark: nothing reads scope yet.
-- Rollback: docs/validation/VTID-05576/rollback-050000-chat-messages-scope.sql.

-- impact-allow-solo-migration: adds one column and one guard trigger to chat_messages; readers and writers ship in later lanes.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'community';

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chat_messages'::regclass AND conname = 'chat_messages_scope_check') THEN
    ALTER TABLE public.chat_messages
      ADD CONSTRAINT chat_messages_scope_check CHECK (scope IN ('community', 'network'));
  END IF;
END
$mig$;

UPDATE public.chat_messages SET scope = 'community' WHERE scope IS NULL;

COMMENT ON COLUMN public.chat_messages.scope IS
  'VTID-05576: community = a tenant-context message (tenant_id is the shared tenant); network = a message between two network_visible members, tenant_id is only the sender''s context. Written by send_message()/send_message_as().';

CREATE OR REPLACE FUNCTION public.chat_messages_scope_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.scope IS NOT DISTINCT FROM OLD.scope THEN
    RETURN NEW;
  END IF;
  IF NEW.scope IS NOT NULL AND NEW.scope <> 'community'
     AND coalesce(current_setting('vitana.chat_send_rpc', true), '') <> 'on' THEN
    RAISE EXCEPTION 'chat_messages.scope % is written only by send_message()', NEW.scope USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_messages_scope_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_chat_messages_scope_guard ON public.chat_messages;
CREATE TRIGGER trg_chat_messages_scope_guard
  BEFORE INSERT OR UPDATE OF scope ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_messages_scope_guard();

COMMIT;
