-- Vitana ID — Release A · 7/9
-- Backfill profiles.vitana_id for every existing user.
--
-- Strategy:
--   1. Loop in batches of 1000 to keep WAL pressure manageable.
--      The IO playbook flagged a prior disk-IO crisis on this DB; batching
--      lets us monitor and abort if needed.
--   2. Each row gets a fresh suggestion from generate_vitana_id_suggestion(),
--      which already checks handle_aliases (populated in 6/9) for collisions.
--   3. Mark legacy users as locked (vitana_id_locked = true) — they have no
--      onboarding card to confirm on, so the generated value is final for them.
--   4. Mirror trigger from 5/9 fires automatically -> app_users.vitana_id
--      updates in lockstep, no separate backfill needed for app_users.
--   5. Replace policy: profiles.handle := vitana_id. The handle column stays
--      (avoids breaking frontend reads) but its semantics change to "mirror
--      of vitana_id". Old handle values were preserved in handle_aliases (6/9).
--   6. Finally tighten profiles.vitana_id to NOT NULL + CHECK regex.
--
-- Run this OFF-PEAK. If it gets killed mid-batch, just re-run — it picks up
-- where it left off because the WHERE clause filters NULL vitana_id.

DO $backfill$
DECLARE
  batch_size int := 1000;
  rows_done  int := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT user_id
        FROM public.profiles
       WHERE vitana_id IS NULL
       LIMIT batch_size
    )
    UPDATE public.profiles p
       SET vitana_id        = public.generate_vitana_id_suggestion(p.display_name, p.full_name, p.email),
           vitana_id_locked = true
      FROM batch
     WHERE p.user_id = batch.user_id;

    GET DIAGNOSTICS rows_done = ROW_COUNT;
    EXIT WHEN rows_done = 0;
    RAISE NOTICE 'vitana_id backfill: % rows updated this batch', rows_done;
  END LOOP;
END;
$backfill$;

-- Replace policy: handle becomes a mirror of vitana_id from now on.
-- handle_aliases already preserved the legacy values (migration 6/9).
UPDATE public.profiles
   SET handle = vitana_id
 WHERE handle IS DISTINCT FROM vitana_id;

-- Tighten constraints now that every row has a value.
ALTER TABLE public.profiles
  ALTER COLUMN vitana_id SET NOT NULL;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_vitana_id_format_chk
  CHECK (vitana_id ~ '^[a-z][a-z0-9]{3,11}$');
