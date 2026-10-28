-- VTID-05023 part 4 (auth -> Aurora bridge), Supabase side. WINDOW STEP —
-- do NOT run before the cutover window (runbook part 11, at the flip, after
-- scripts/aws/aurora-cutover-auth-bridge.sql is on Aurora and the gateway
-- serving POST /api/v1/internal/auth-bridge/user-event is live).
-- Reverse: scripts/aws/supabase-cutover-auth-bridge-rollback.sql.
--
-- What it does, in one transaction:
--   1. Creates schema auth_bridge (not exposed through PostgREST) with one
--      trigger function that posts a minimal auth.users event to the gateway
--      through pg_net, the way notify_welcome_discount() already does: the URL
--      and the bearer token come from Supabase Vault, never from this file.
--   2. Three triggers on auth.users: AFTER INSERT, AFTER UPDATE OF
--      email_confirmed_at (only when it changed), AFTER DELETE.
--   3. Disables exactly the six provisioning triggers that write `public`.
--      before_auth_user_delete_cleanup_contacts stays ENABLED (it unblocks
--      auth user deletion; the Aurora side of it runs in
--      public.auth_bridge_handle_deleted_user()).
--
-- The payload carries only id, email, raw_user_meta_data, raw_app_meta_data,
-- created_at and email_confirmed_at — never encrypted_password, tokens or
-- phone. A failed post never blocks sign-up or deletion (pg_net is
-- asynchronous, and any error is downgraded to a WARNING); the gateway's
-- reconciliation job (AUTH_BRIDGE_RECONCILE_ENABLED) catches up on anything lost.
--
-- Before running, an operator creates the two Vault secrets (values are not in
-- the repo):
--   select vault.create_secret('https://gateway.vitanaland.com', 'auth_bridge_gateway_url');
--   select vault.create_secret('<GATEWAY_SERVICE_TOKEN of the prod gateway>', 'auth_bridge_service_token');
-- The DO block below refuses to continue if either is missing.
--
-- Needs the role that owns auth.users' triggers (the one that created the
-- existing on_auth_user_* triggers via migrations). ALTER TABLE ... DISABLE
-- TRIGGER takes a short ACCESS EXCLUSIVE lock on auth.users: sign-ins wait
-- for it, which is why this runs inside the window.

BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'auth_bridge_gateway_url' AND coalesce(decrypted_secret, '') <> '') THEN
    RAISE EXCEPTION 'Vault secret auth_bridge_gateway_url is missing — create it first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'auth_bridge_service_token' AND coalesce(decrypted_secret, '') <> '') THEN
    RAISE EXCEPTION 'Vault secret auth_bridge_service_token is missing — create it first';
  END IF;
  IF to_regnamespace('net') IS NULL THEN
    RAISE EXCEPTION 'pg_net (schema net) is not installed';
  END IF;
END
$guard$;

CREATE SCHEMA IF NOT EXISTS auth_bridge;
REVOKE ALL ON SCHEMA auth_bridge FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION auth_bridge.notify_gateway()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_url text;
  v_token text;
  v_record jsonb;
  v_old jsonb;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'auth_bridge_gateway_url' LIMIT 1;
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'auth_bridge_service_token' LIMIT 1;
  IF coalesce(v_url, '') = '' OR coalesce(v_token, '') = '' THEN
    RAISE WARNING 'auth_bridge.notify_gateway: Vault secrets missing, % event for % not sent', TG_OP, coalesce(NEW.id, OLD.id);
    RETURN NULL;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    v_record := jsonb_build_object(
      'id', NEW.id,
      'email', NEW.email,
      'raw_user_meta_data', NEW.raw_user_meta_data,
      'raw_app_meta_data', NEW.raw_app_meta_data,
      'created_at', NEW.created_at,
      'email_confirmed_at', NEW.email_confirmed_at);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    v_old := jsonb_build_object(
      'id', OLD.id,
      'email', OLD.email,
      'email_confirmed_at', OLD.email_confirmed_at);
  END IF;

  PERFORM net.http_post(
    url := rtrim(v_url, '/') || '/api/v1/internal/auth-bridge/user-event',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_token),
    body := jsonb_build_object(
      'type', TG_OP,
      'schema', TG_TABLE_SCHEMA,
      'table', TG_TABLE_NAME,
      'record', v_record,
      'old_record', v_old),
    timeout_milliseconds := 5000);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'auth_bridge.notify_gateway: % event for % not sent: %', TG_OP, coalesce(NEW.id, OLD.id), SQLERRM;
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION auth_bridge.notify_gateway() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS auth_bridge_after_insert ON auth.users;
CREATE TRIGGER auth_bridge_after_insert
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION auth_bridge.notify_gateway();

DROP TRIGGER IF EXISTS auth_bridge_after_confirm ON auth.users;
CREATE TRIGGER auth_bridge_after_confirm
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  WHEN (OLD.email_confirmed_at IS DISTINCT FROM NEW.email_confirmed_at)
  EXECUTE FUNCTION auth_bridge.notify_gateway();

DROP TRIGGER IF EXISTS auth_bridge_after_delete ON auth.users;
CREATE TRIGGER auth_bridge_after_delete
  AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION auth_bridge.notify_gateway();

-- The six provisioning triggers (docs/validation/VTID-05023/side-effects.md C).
ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created;
ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created_generate_discount;
ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created_preferences;
ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created_wallet;
ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_platform_provision;
ALTER TABLE auth.users DISABLE TRIGGER on_user_journey_created;

-- Verify the end state before committing: 6 disabled, 3 bridge + the
-- contacts cleanup trigger enabled.
DO $verify$
DECLARE
  v_disabled int;
  v_enabled int;
BEGIN
  SELECT count(*) INTO v_disabled FROM pg_trigger
   WHERE tgrelid = 'auth.users'::regclass AND tgenabled = 'D'
     AND tgname IN ('on_auth_user_created', 'on_auth_user_created_generate_discount',
                    'on_auth_user_created_preferences', 'on_auth_user_created_wallet',
                    'on_auth_user_platform_provision', 'on_user_journey_created');
  SELECT count(*) INTO v_enabled FROM pg_trigger
   WHERE tgrelid = 'auth.users'::regclass AND tgenabled <> 'D'
     AND tgname IN ('auth_bridge_after_insert', 'auth_bridge_after_confirm',
                    'auth_bridge_after_delete', 'before_auth_user_delete_cleanup_contacts');
  IF v_disabled <> 6 OR v_enabled <> 4 THEN
    RAISE EXCEPTION 'auth bridge end state wrong: % of 6 provisioning triggers disabled, % of 4 bridge/cleanup triggers enabled', v_disabled, v_enabled;
  END IF;
END
$verify$;

COMMIT;
