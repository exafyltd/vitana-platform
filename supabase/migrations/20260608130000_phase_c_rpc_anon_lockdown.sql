-- PHASE C: lock down anon EXECUTE on data-returning SECURITY DEFINER functions  (2026-06-08)
-- The anon key could call ~199 SECURITY DEFINER RPCs that run as owner and bypass table grants,
-- including PII enumeration (get_user_profile_by_identifier, check_phone_on_platform,
-- get_recent_conversations, get_ticket_by_qr_token), wallet/credit mutations, and decrypt_api_key.
-- This revokes EXECUTE from anon on data-returning ones, while PRESERVING:
--   * boolean RLS-helper functions (revoking them would break policy evaluation)
--   * any function referenced inside an RLS policy (same reason)
--   * a small public allowlist (share/OG pages + signup helpers)
-- authenticated + service_role retain access, so logged-in apps and the gateway are unaffected.

BEGIN;

-- 1) Revoke anon EXECUTE on data-returning definer fns (keep authenticated + service_role) ----------
DO $$
DECLARE r record;
  allow text[] := ARRAY[
    'get_public_campaign_details','get_public_event_details','get_public_vitana_index',
    'resolve_event_by_slug','generate_event_slug','generate_unique_handle',
    'generate_vitana_id_suggestion','allocate_vitana_id'];
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.prosecdef
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      AND pg_get_function_result(p.oid) NOT IN ('trigger','void','boolean')  -- keep boolean RLS helpers
      AND p.proname <> ALL(allow)
      AND NOT EXISTS (                                                        -- keep policy-referenced fns
        SELECT 1 FROM pg_policies pol
        WHERE pol.schemaname = 'public'
          AND (coalesce(pol.qual,'') || ' ' || coalesce(pol.with_check,'')) ILIKE '%' || p.proname || '%')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon;', r.proname, r.args);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION public.%I(%s) TO authenticated, service_role;', r.proname, r.args);
  END LOOP;
END $$;

-- 2) Hardlist: crypto + wallet-mutation fns are server-only — revoke from authenticated too ----------
DO $$
DECLARE r record;
  hard text[] := ARRAY[
    'decrypt_api_key','encrypt_api_key','debit_wallet_for_spend',
    'credit_wallet_for_earning','increment_wallet_balance','credit_deposit'];
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname = ANY(hard)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated;', r.proname, r.args);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION public.%I(%s) TO service_role;', r.proname, r.args);
  END LOOP;
END $$;

COMMIT;
