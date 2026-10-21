-- =============================================================================
-- VTID-04981 — fn_consume_credits: only the gateway may call it
-- -----------------------------------------------------------------------------
-- VTID-03107 granted EXECUTE on fn_consume_credits to `authenticated`. The
-- function is SECURITY DEFINER, takes any p_user_id and never checks
-- auth.uid(), so any signed-in member could call
-- POST /rest/v1/rpc/fn_consume_credits with another member's id and debit
-- that member's earned VTNA (p_bucket 'reward_credits') or purchased credits.
-- Verified read-only 2026-10-08: no such debit has ever happened
-- (0 wallet_transactions with metadata.source 'paywall:%').
--
-- The only caller is the gateway on the service role
-- (services/gateway/src/services/entitlement-service-repository.ts). This
-- migration changes access only; the function body and every bucket behave
-- exactly as before for that caller.
-- =============================================================================

BEGIN;

REVOKE ALL ON FUNCTION public.fn_consume_credits(uuid, uuid, integer, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_consume_credits(uuid, uuid, integer, text, text, text) TO service_role;

DO $check$
BEGIN
  IF has_function_privilege('authenticated', 'public.fn_consume_credits(uuid, uuid, integer, text, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_consume_credits(uuid, uuid, integer, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-04981: fn_consume_credits must not be executable by members';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_consume_credits(uuid, uuid, integer, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-04981: the gateway (service_role) must keep EXECUTE on fn_consume_credits';
  END IF;
END
$check$;

COMMIT;
