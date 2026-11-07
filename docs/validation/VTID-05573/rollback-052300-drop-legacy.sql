-- VTID-05573 rollback of 20261102052300 (run FIRST). Recreates the four dropped legacy tables from the bak_* snapshots with
-- their exact rows (columns, defaults, primary key), restores the thread_id foreign keys of both participant tables (thread_participants and global_thread_participants), turns RLS on and grants service_role
-- only. REFUSES (changes nothing) unless every bak_* snapshot is present.
-- Limit: the original v1 RLS policies, publication membership and secondary indexes are not part of a data snapshot. Until the
-- v1 migration chain (20250917143525 and later) is replayed for them, the restored tables are reachable by service_role only,
-- which is the safe state (no member can read them). Run rollback-check.sql afterwards.
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $rb$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['messages', 'message_threads', 'global_message_threads', 'global_messages'] LOOP
    IF to_regclass('public.bak_' || v_t) IS NULL THEN
      RAISE EXCEPTION 'VTID-05573 rollback refused: snapshot bak_% is missing', v_t USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  FOREACH v_t IN ARRAY ARRAY['message_threads', 'global_message_threads', 'messages', 'global_messages'] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN
      EXECUTE format('CREATE TABLE public.%I (LIKE public.%I INCLUDING DEFAULTS)', v_t, 'bak_' || v_t);
      EXECUTE format('ALTER TABLE public.%I ADD PRIMARY KEY (id)', v_t);
      EXECUTE format('INSERT INTO public.%I SELECT * FROM public.%I', v_t, 'bak_' || v_t);
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', v_t);
  END LOOP;
  -- The participant thread_id foreign keys that 20261102052300 dropped (vitana-v1 20250917143525 / 20250917151013 / 20250917153624).
  IF to_regclass('public.thread_participants') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conrelid = 'public.thread_participants'::regclass AND contype = 'f' AND confrelid = 'public.message_threads'::regclass) THEN
    ALTER TABLE public.thread_participants
      ADD CONSTRAINT thread_participants_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.message_threads(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF to_regclass('public.global_thread_participants') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conrelid = 'public.global_thread_participants'::regclass AND contype = 'f' AND confrelid = 'public.global_message_threads'::regclass) THEN
    ALTER TABLE public.global_thread_participants
      ADD CONSTRAINT fk_global_thread_participants_thread FOREIGN KEY (thread_id) REFERENCES public.global_message_threads(id) ON DELETE CASCADE NOT VALID;
  END IF;
END
$rb$;
COMMIT;
