-- Vitana ID — Release B · Migration A (chat_messages)
-- VTID-01967
--
-- Add denormalized sender_vitana_id / receiver_vitana_id columns to
-- chat_messages so support engineers and voice tooling can read/quote
-- speakable IDs without joining profiles. Backfill once from profiles.
-- Writers (services/gateway/src/routes/chat.ts) populate at insert time.
--
-- Idempotent re-check that metadata column exists — chat.ts:219 + 334
-- already reference metadata in the SELECT/INSERT shape, so we expect it,
-- but ADD COLUMN IF NOT EXISTS makes this re-runnable on any environment.

-- 1. Columns (nullable — Release B contract is "null-tolerant writers").
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS sender_vitana_id   text,
  ADD COLUMN IF NOT EXISTS receiver_vitana_id text,
  ADD COLUMN IF NOT EXISTS metadata           jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.chat_messages.sender_vitana_id IS
  'Denormalized snapshot of profiles.vitana_id for the sender at insert time. Read-only after write — do not update if the user ever changes vitana_id (which is permanent anyway, so this should never matter).';
COMMENT ON COLUMN public.chat_messages.receiver_vitana_id IS
  'Denormalized snapshot of profiles.vitana_id for the receiver at insert time.';

-- 2. Backfill from profiles.vitana_id. Release A backfill (migration 7/9
-- of 20260427) populated profiles.vitana_id for every user, so this is a
-- straight join. Batched in case the table is large.
DO $backfill$
DECLARE
  batch_size int := 5000;
  rows_done  int := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
        FROM public.chat_messages
       WHERE sender_vitana_id IS NULL OR receiver_vitana_id IS NULL
       LIMIT batch_size
    )
    UPDATE public.chat_messages cm
       SET sender_vitana_id   = COALESCE(cm.sender_vitana_id,
                                  (SELECT p.vitana_id FROM public.profiles p WHERE p.user_id = cm.sender_id)),
           receiver_vitana_id = COALESCE(cm.receiver_vitana_id,
                                  (SELECT p.vitana_id FROM public.profiles p WHERE p.user_id = cm.receiver_id))
      FROM batch
     WHERE cm.id = batch.id;

    GET DIAGNOSTICS rows_done = ROW_COUNT;
    EXIT WHEN rows_done = 0;
    RAISE NOTICE 'chat_messages vitana_id backfill: % rows updated this batch', rows_done;
  END LOOP;
END;
$backfill$;
