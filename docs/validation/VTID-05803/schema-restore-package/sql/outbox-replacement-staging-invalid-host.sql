-- VTID-05803 staging replay: corrected pg_net replacement (STAGING ONLY, not applied to production).
-- Verified against production definitions read via connector on 2026-11-17:
--   notify_test_user_confirmation: URL .../functions/v1/send-test-user-confirmation, header X-Trigger-Secret, body {application_id}
--   notify_welcome_discount:       URL .../functions/v1/send-welcome-discount, header X-Trigger-Secret, body {discount_code_id}
-- The earlier aurora-cutover-outbox.sql used an OLDER welcome-discount definition (Authorization bearer, extra body fields).
-- This file matches the current production behaviour. Secrets are references only; the gateway outbound worker resolves them.
-- Staging safeguard, two layers: (1) the URL host is staging-disabled.invalid (reserved .invalid TLD, never resolves, never the
--   production Supabase host); (2) the worker never sends when VITANA_ENV = 'staging' (outbound-http-worker.ts:102).
--   The restore script fails if any function body still contains the production host.
CREATE OR REPLACE FUNCTION public.notify_test_user_confirmation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  INSERT INTO public.outbound_http_requests (url, method, headers, body, source)
  VALUES (
    'https://staging-disabled.invalid/functions/v1/send-test-user-confirmation',
    'POST',
    jsonb_build_object('Content-Type', 'application/json',
                       'X-Trigger-Secret', jsonb_build_object('secret_ref', 'email_trigger_secret')),
    jsonb_build_object('application_id', NEW.id),
    'notify_test_user_confirmation');
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.notify_welcome_discount()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  INSERT INTO public.outbound_http_requests (url, method, headers, body, source)
  VALUES (
    'https://staging-disabled.invalid/functions/v1/send-welcome-discount',
    'POST',
    jsonb_build_object('Content-Type', 'application/json',
                       'X-Trigger-Secret', jsonb_build_object('secret_ref', 'email_trigger_secret')),
    jsonb_build_object('discount_code_id', NEW.id),
    'notify_welcome_discount');
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to queue welcome discount email: %', SQLERRM;
  RETURN NEW;
END $fn$;
-- Triggers trg_send_test_user_confirmation and on_discount_code_created_send_email already exist on Aurora
-- (services/postgrest-aurora-proxy/aurora-restore-04-triggers.sql). Only the functions are replaced here.
