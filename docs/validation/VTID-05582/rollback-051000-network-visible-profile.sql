-- VTID-05582 rollback of 20261102051000: drop the trigger, both helpers and the three columns.
-- Refuses while any member has opted in (network_visible) or chosen a non-default messaging_preference, so an opt-in is
-- never destroyed silently; set mt.rollback_force = 'on' for the transaction to override after the owner agrees.
-- Apply AFTER rollback-051100 (request_connection reads the columns). Through RUN-MIGRATION only (section 7d).
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $rb$
DECLARE v_n bigint;
BEGIN
  IF to_regclass('public.global_community_profiles') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.global_community_profiles'::regclass AND attname = 'network_visible' AND NOT attisdropped) THEN
    IF to_regprocedure('public.request_connection(uuid,text,text)') IS NOT NULL THEN
      RAISE EXCEPTION 'VTID-05582 rollback: apply rollback-051100-connection-rpcs.sql first (request_connection reads the columns)';
    END IF;
    EXECUTE 'SELECT count(*) FROM public.global_community_profiles WHERE network_visible OR messaging_preference <> ''connections''' INTO v_n;
    IF v_n > 0 AND coalesce(current_setting('mt.rollback_force', true), '') <> 'on' THEN
      RAISE EXCEPTION 'VTID-05582 rollback: % profile(s) carry an opt-in or a messaging preference; set mt.rollback_force=on to drop them', v_n;
    END IF;
    DROP TRIGGER IF EXISTS trg_gcp_network_visible_guard ON public.global_community_profiles;
    ALTER TABLE public.global_community_profiles
      DROP CONSTRAINT IF EXISTS gcp_messaging_preference_check,
      DROP COLUMN IF EXISTS network_visible,
      DROP COLUMN IF EXISTS network_visible_decided_at,
      DROP COLUMN IF EXISTS messaging_preference;
  END IF;
END
$rb$;
DROP FUNCTION IF EXISTS public.gcp_network_visible_guard();
DROP FUNCTION IF EXISTS public.is_network_excluded_account(uuid);
COMMIT;
