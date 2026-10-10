-- VTID-05023 part 4: exact reverse of scripts/aws/supabase-cutover-auth-bridge.sql.
-- Run on Supabase only when rolling the cutover back (runbook part 12), i.e.
-- when `public` is served from Supabase again: re-enables the six
-- provisioning triggers and removes the bridge's webhook triggers and
-- function. before_auth_user_delete_cleanup_contacts was never touched.
--
-- The two Vault secrets (auth_bridge_gateway_url, auth_bridge_service_token)
-- were created by an operator, not by the forward file, so this file leaves
-- them; delete them by hand if the bridge is retired for good.
--
-- Users who signed up while the bridge was active were provisioned on
-- Aurora, not on Supabase. Part 12 (i)'s Aurora->Supabase CDC carries their
-- rows back; if it did not run, they have no `public` rows on Supabase. List
-- them with
--   select id, email, created_at from auth.users where created_at >= '<flip time>';

BEGIN;

ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created;
ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created_generate_discount;
ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created_preferences;
ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created_wallet;
ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_platform_provision;
ALTER TABLE auth.users ENABLE TRIGGER on_user_journey_created;

DROP TRIGGER IF EXISTS auth_bridge_after_delete ON auth.users;
DROP TRIGGER IF EXISTS auth_bridge_after_confirm ON auth.users;
DROP TRIGGER IF EXISTS auth_bridge_after_insert ON auth.users;

DROP FUNCTION IF EXISTS auth_bridge.notify_gateway();
DROP SCHEMA IF EXISTS auth_bridge;

DO $verify$
DECLARE
  v_enabled int;
  v_bridge int;
BEGIN
  SELECT count(*) INTO v_enabled FROM pg_trigger
   WHERE tgrelid = 'auth.users'::regclass AND tgenabled <> 'D'
     AND tgname IN ('on_auth_user_created', 'on_auth_user_created_generate_discount',
                    'on_auth_user_created_preferences', 'on_auth_user_created_wallet',
                    'on_auth_user_platform_provision', 'on_user_journey_created',
                    'before_auth_user_delete_cleanup_contacts');
  SELECT count(*) INTO v_bridge FROM pg_trigger
   WHERE tgrelid = 'auth.users'::regclass AND tgname LIKE 'auth_bridge_%';
  IF v_enabled <> 7 OR v_bridge <> 0 THEN
    RAISE EXCEPTION 'rollback end state wrong: % of 7 original triggers enabled, % bridge triggers left', v_enabled, v_bridge;
  END IF;
END
$verify$;

COMMIT;
