-- =============================================================================
-- VTID-03089 — Backfill sender_vitana_id / receiver_vitana_id on backfilled rows
-- =============================================================================
-- The 1,876 hello-message inserts (metadata.backfill_run = '2026-05-19') and
-- the Vitana German group welcome (metadata.source = 'vitana_group_welcome')
-- were inserted via direct SQL, which didn't denormalize the Vitana IDs that
-- the live /chat/send endpoint always sets. That caused vitana-v1's inbox
-- conversation grouping to under-count distinct senders for some users.
--
-- This UPDATE pulls vitana_id from app_users for every backfill row missing
-- the denormalized fields. Read-modify-write, idempotent.
-- =============================================================================

BEGIN;

-- a) Hello backfill rows (sender + receiver both need patching).
UPDATE public.chat_messages cm
SET
  sender_vitana_id = COALESCE(
    cm.sender_vitana_id,
    (SELECT u.vitana_id FROM public.app_users u WHERE u.user_id = cm.sender_id)
  ),
  receiver_vitana_id = COALESCE(
    cm.receiver_vitana_id,
    (SELECT u.vitana_id FROM public.app_users u WHERE u.user_id = cm.receiver_id)
  )
WHERE cm.metadata->>'backfill_run' = '2026-05-19'
  AND (cm.sender_vitana_id IS NULL OR cm.receiver_vitana_id IS NULL);

-- b) Vitana German group welcome (group message; receiver_id is NULL so
--    only sender_vitana_id is meaningful).
UPDATE public.chat_messages cm
SET sender_vitana_id = COALESCE(
  cm.sender_vitana_id,
  (SELECT u.vitana_id FROM public.app_users u WHERE u.user_id = cm.sender_id)
)
WHERE cm.metadata->>'source' = 'vitana_group_welcome'
  AND cm.sender_vitana_id IS NULL;

COMMIT;

-- Sanity tally for the workflow log.
SELECT
  (SELECT COUNT(*) FROM public.chat_messages
    WHERE metadata->>'backfill_run' = '2026-05-19'
      AND sender_vitana_id IS NOT NULL
  ) AS backfill_rows_with_sender_vid,
  (SELECT COUNT(*) FROM public.chat_messages
    WHERE metadata->>'backfill_run' = '2026-05-19'
      AND sender_vitana_id IS NULL
  ) AS backfill_rows_still_null_sender_vid,
  (SELECT COUNT(*) FROM public.chat_messages
    WHERE metadata->>'backfill_run' = '2026-05-19'
      AND receiver_vitana_id IS NOT NULL
  ) AS backfill_rows_with_receiver_vid,
  (SELECT COUNT(*) FROM public.chat_messages
    WHERE metadata->>'source' = 'vitana_group_welcome'
      AND sender_vitana_id IS NOT NULL
  ) AS welcome_rows_with_sender_vid;
