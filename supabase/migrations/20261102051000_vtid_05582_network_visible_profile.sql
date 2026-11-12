-- VTID-05582 (mt-network-r2/network-visibility-db) N1: global_community_profiles.network_visible and the rule-45 guard.
--
-- A member is reachable from OTHER communities (the "Network" scope) only if they opted in. Three new columns on
-- public.global_community_profiles (a vitana-v1 table that lives in the same Supabase project):
--   * network_visible            boolean NOT NULL DEFAULT false  - the opt-in. Every existing row backfills to false.
--   * network_visible_decided_at timestamptz NULL                - set by the trigger when network_visible changes; a client
--                                                                  cannot write or back-date it.
--   * messaging_preference       text NOT NULL DEFAULT 'connections' CHECK (everyone | connections | nobody).
--
-- Rules 43-45 (CLAUDE.md): a service bot, a notification test actor or a platform-only account must never be reachable
-- by a real member. BEFORE INSERT OR UPDATE trigger gcp_network_visible_guard() forces network_visible = false for any
-- user_id listed in service_bot_accounts, notification_test_actors or platform_only_accounts. The three lists are read
-- through public.is_network_excluded_account(uuid), which skips a list that does not exist yet (platform_only_accounts
-- is created by another spec) and is not callable by clients, so the lists cannot be enumerated.
--
-- Residual (rule 44): an account listed AFTER its profile exists is not flipped back until its next profile write.
-- The 04888 trigger set has the same gap; "register first" stays the process.
--
-- Dark: nothing reads the columns until request_connection() (20261102051100) and the messaging lanes. Expand only.
-- Safe to re-run. If global_community_profiles is absent (a stack without the v1 schema) the file does nothing.
-- Rollback: docs/validation/VTID-05582/rollback-051000-network-visible-profile.sql
-- Order: docs/multitenancy/MIGRATION-QUEUE.md (mt-network-r2 rows; the queue row is added with the platform follow-up).

-- impact-allow-solo-migration: expand only (three columns, one trigger, one helper); nothing reads them before the RPC lane.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.is_network_excluded_account(p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_list text;
  v_hit boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  FOREACH v_list IN ARRAY ARRAY['service_bot_accounts', 'notification_test_actors', 'platform_only_accounts'] LOOP
    IF to_regclass('public.' || v_list) IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = to_regclass('public.' || v_list) AND a.attname = 'user_id' AND NOT a.attisdropped) THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE user_id = $1)', v_list) INTO v_hit USING p_user_id;
      IF v_hit THEN
        RETURN true;
      END IF;
    END IF;
  END LOOP;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.is_network_excluded_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_network_excluded_account(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_network_excluded_account(uuid) TO service_role;

-- SECURITY DEFINER: members update their own profile as `authenticated`, which cannot execute the helper.
CREATE OR REPLACE FUNCTION public.gcp_network_visible_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.network_visible IS DISTINCT FROM false AND public.is_network_excluded_account(NEW.user_id) THEN
    NEW.network_visible := false;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.network_visible_decided_at := CASE WHEN NEW.network_visible THEN now() ELSE NULL END;
  ELSIF NEW.network_visible IS DISTINCT FROM OLD.network_visible THEN
    NEW.network_visible_decided_at := now();
  ELSE
    NEW.network_visible_decided_at := OLD.network_visible_decided_at;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gcp_network_visible_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gcp_network_visible_guard() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gcp_network_visible_guard() TO service_role;

DO $mig$
BEGIN
  IF to_regclass('public.global_community_profiles') IS NULL THEN
    RAISE NOTICE 'VTID-05582: public.global_community_profiles is absent; columns and trigger skipped';
    RETURN;
  END IF;

  ALTER TABLE public.global_community_profiles
    ADD COLUMN IF NOT EXISTS network_visible boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS network_visible_decided_at timestamptz,
    ADD COLUMN IF NOT EXISTS messaging_preference text NOT NULL DEFAULT 'connections';

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.global_community_profiles'::regclass
                    AND conname = 'gcp_messaging_preference_check') THEN
    ALTER TABLE public.global_community_profiles
      ADD CONSTRAINT gcp_messaging_preference_check CHECK (messaging_preference IN ('everyone', 'connections', 'nobody'));
  END IF;

  DROP TRIGGER IF EXISTS trg_gcp_network_visible_guard ON public.global_community_profiles;
  CREATE TRIGGER trg_gcp_network_visible_guard
    BEFORE INSERT OR UPDATE ON public.global_community_profiles
    FOR EACH ROW EXECUTE FUNCTION public.gcp_network_visible_guard();
END
$mig$;

COMMIT;
