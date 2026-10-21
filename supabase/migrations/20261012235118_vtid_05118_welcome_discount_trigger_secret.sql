-- VTID-05118 — the welcome-discount email trigger never sent anything.
--
-- notify_welcome_discount() (vitana-v1 20260210141933_…sql) built the edge URL
-- and the authorization header from the vault names supabase_url and
-- service_role_key. Vault holds neither, so the URL was NULL, net.http_post
-- failed, and the function's WHEN OTHERS handler turned that into a WARNING:
-- no welcome-discount email has been sent since the trigger was created.
--
-- This redefines the function only, the same way notify_test_user_confirmation()
-- works (vitana-v1 20260518010000_test_user_confirmation_vault.sql):
--   * the edge URL is project-public, so it is a constant here, not a secret;
--   * the call carries X-Trigger-Secret from vault email_trigger_secret, which
--     already exists; send-welcome-discount checks it against the
--     EMAIL_TRIGGER_SECRET edge secret (isTriggerSecretCaller);
--   * a missing vault secret skips the call with a WARNING.
-- The body is only discount_code_id: the function loads the code row itself.
-- SECURITY DEFINER, search_path and the outer WHEN OTHERS stay, so a failure
-- here can never block a signup. Trigger on_discount_code_created_send_email
-- is unchanged. No secret value is in this file.

CREATE OR REPLACE FUNCTION public.notify_welcome_discount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  edge_url       constant text := 'https://inmkhvwdcuyhnxkgfvsb.supabase.co/functions/v1/send-welcome-discount';
  trigger_secret text;
BEGIN
  SELECT decrypted_secret
    INTO trigger_secret
    FROM vault.decrypted_secrets
   WHERE name = 'email_trigger_secret'
   LIMIT 1;

  IF trigger_secret IS NULL THEN
    RAISE WARNING
      'notify_welcome_discount: vault secret "email_trigger_secret" not found — skipping HTTP call';
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := edge_url,
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'X-Trigger-Secret', trigger_secret
    ),
    body    := jsonb_build_object('discount_code_id', NEW.id)
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Don't block user creation if email sending fails
  RAISE WARNING 'Failed to send welcome discount email: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- Trigger-only SECURITY DEFINER function: nothing calls it directly, and a
-- trigger fires without an EXECUTE check, so client roles lose EXECUTE
-- (VTID-05041 definer lockdown).
REVOKE ALL ON FUNCTION public.notify_welcome_discount() FROM PUBLIC, anon, authenticated;
