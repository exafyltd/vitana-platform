-- Vitana ID v2 — re-mint existing users in chronological order (VTID-01987)
-- One-time exception to the "vitana_id is permanent" invariant. Authorized
-- by user 2026-04-27. Existing users (~20) are re-numbered in
-- auth.users.created_at ASC order so user #1 to register gets suffix 1,
-- user #25 gets suffix 25, etc. Their previous random-suffix IDs are
-- preserved in handle_aliases for redirect.

BEGIN;

-- 1. Park every existing vitana_id as a redirect alias before we overwrite
--    the column. Already-aliased values are skipped (idempotent if re-run).
INSERT INTO public.handle_aliases (old_handle, user_id)
SELECT vitana_id, user_id
  FROM public.profiles
 WHERE vitana_id IS NOT NULL
ON CONFLICT (old_handle) DO NOTHING;

-- 2. Reset the global sequence to 1 BEFORE the re-mint loop. Sequence is
--    monotonic within the loop; user #N gets seq N (modulo any alias
--    collisions, which would burn a value via allocate_vitana_id).
ALTER SEQUENCE public.vitana_id_seq RESTART WITH 1;

-- 3. Re-mint in chronological order. We re-fetch display_name/full_name/email
--    from each profile so the BASE part of the new ID stays sensible (e.g.
--    'dragan' for the same user, just with a smaller suffix).
DO $remint$
DECLARE
  r RECORD;
  v_new_id  text;
  v_new_seq bigint;
BEGIN
  FOR r IN
    SELECT p.user_id,
           p.display_name,
           p.full_name,
           p.email
      FROM public.profiles p
      JOIN auth.users u ON u.id = p.user_id
     ORDER BY u.created_at ASC, p.user_id ASC
  LOOP
    SELECT a.vitana_id, a.registration_seq
      INTO v_new_id, v_new_seq
      FROM public.allocate_vitana_id(r.display_name, r.full_name, r.email) a;

    UPDATE public.profiles
       SET vitana_id        = v_new_id,
           handle           = v_new_id,
           registration_seq = v_new_seq
     WHERE user_id = r.user_id;
  END LOOP;
END;
$remint$;

-- 4. Sanity assertions before commit. Each one fails the migration loudly
--    if the re-mint produced an inconsistent state.
DO $assert$
DECLARE
  v_count int;
  v_drift int;
BEGIN
  -- Every profile must now carry a non-null vitana_id and registration_seq.
  SELECT count(*) INTO v_count
    FROM public.profiles
   WHERE vitana_id IS NULL OR registration_seq IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'vitana_id v2 re-mint left % profiles with null id or seq', v_count;
  END IF;

  -- Every vitana_id must end with the row's registration_seq (proves the
  -- allocator produced a clean <base><seq> output).
  SELECT count(*) INTO v_count
    FROM public.profiles
   WHERE vitana_id !~ ('[a-z][a-z0-9]*' || registration_seq::text || '$');
  IF v_count > 0 THEN
    RAISE EXCEPTION 'vitana_id v2 re-mint produced % profiles where suffix != registration_seq', v_count;
  END IF;

  -- Mirror trigger should have synced every app_users row. If it didn't,
  -- the trigger is broken and we want to know now, not in production.
  SELECT count(*) INTO v_drift
    FROM public.app_users a
    JOIN public.profiles p USING (user_id)
   WHERE a.vitana_id IS DISTINCT FROM p.vitana_id;
  IF v_drift > 0 THEN
    RAISE EXCEPTION 'vitana_id v2 re-mint left % app_users rows out of sync with profiles', v_drift;
  END IF;
END;
$assert$;

COMMIT;
