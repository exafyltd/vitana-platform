-- VTID-05582 (mt-network-r2/network-visibility-db) N2: connection_requests writes only through two RPCs.
--
-- Today (vitana-v1 20251111124306:63-77) a client INSERT only checks from_user_id = auth.uid() and a recipient UPDATE
-- is unrestricted, so a sender can insert a row that is already status = 'accepted', and a recipient can rewrite any
-- column. This file closes both:
--   * REVOKE INSERT, UPDATE ON public.connection_requests FROM authenticated, anon (the RLS policies stay; with no
--     privilege they are never reached). SELECT stays, limited by the existing own-row policy. service_role is unchanged.
--   * public.request_connection(p_to uuid, p_scope text DEFAULT 'community', p_message text DEFAULT NULL) RETURNS uuid
--     The sender is auth.uid(), never a parameter. community needs a tenant shared by both members (the platform tenant
--     does not count). network needs both members network_visible, a recipient preference other than 'nobody', no
--     unexpired block in either direction (user_blocklist, any tenant) and fewer than 20 requests by the sender in the
--     last 24 hours. The free-text message is cut to 500 characters for community and dropped for network. A repeated
--     request returns the existing row (no second row, a declined request is not re-opened).
--   * public.respond_connection(p_request uuid, p_accept boolean) RETURNS text ('accepted' | 'declined')
--     Only the recipient (to_user_id = auth.uid()) of a still-pending request can answer it.
-- Errors: 28000 not authenticated; 22023 bad argument; 42501 not allowed; 54000 rate limit; P0002 no such pending request.
--
-- Both are SECURITY DEFINER with a pinned search_path; EXECUTE for authenticated and service_role, not anon.
-- connection_requests is a vitana-v1 table in the same Supabase project; if it is absent the revoke is skipped.
-- Known residual: scripts/aws/aurora-cutover-restore-grants.sql:1664,3058 re-grants INSERT/UPDATE if it is replayed;
-- the Aurora cutover lane must drop those two lines (tracked in the PR body).
-- Nothing calls the RPCs yet (messenger-wiring and the v1 screens do, later); dark.
-- Rollback: docs/validation/VTID-05582/rollback-051100-connection-rpcs.sql (re-grants, drops both functions).

-- impact-allow-solo-migration: tightens one table's privileges and adds two functions; the callers ship in later lanes.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.request_connection(p_to uuid, p_scope text DEFAULT 'community', p_message text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_from uuid := (SELECT auth.uid());
  v_id uuid;
  v_pref text;
BEGIN
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_to IS NULL OR p_to = v_from THEN
    RAISE EXCEPTION 'invalid_recipient' USING ERRCODE = '22023';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('community', 'network') THEN
    RAISE EXCEPTION 'invalid_scope' USING ERRCODE = '22023';
  END IF;

  IF p_scope = 'community' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.user_tenants a
        JOIN public.user_tenants b ON b.tenant_id = a.tenant_id
       WHERE a.user_id = v_from AND b.user_id = p_to
         AND NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.tenant_id = a.tenant_id AND t.is_platform)
    ) THEN
      RAISE EXCEPTION 'no_shared_tenant' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.global_community_profiles WHERE user_id = v_from AND network_visible) THEN
      RAISE EXCEPTION 'sender_not_network_visible' USING ERRCODE = '42501';
    END IF;
    SELECT messaging_preference INTO v_pref
      FROM public.global_community_profiles WHERE user_id = p_to AND network_visible;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'recipient_not_network_visible' USING ERRCODE = '42501';
    END IF;
    IF v_pref = 'nobody' THEN
      RAISE EXCEPTION 'recipient_accepts_no_requests' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.user_blocklist b
                WHERE b.expires_at > now()
                  AND ((b.user_id = p_to AND b.blocked_user_id = v_from) OR (b.user_id = v_from AND b.blocked_user_id = p_to))) THEN
      RAISE EXCEPTION 'blocked' USING ERRCODE = '42501';
    END IF;
    IF (SELECT count(*) FROM public.connection_requests
         WHERE from_user_id = v_from AND created_at > now() - interval '24 hours') >= 20 THEN
      RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000';
    END IF;
  END IF;

  INSERT INTO public.connection_requests (from_user_id, to_user_id, status, request_type, message)
  VALUES (v_from, p_to, 'pending', 'normal',
          CASE WHEN p_scope = 'network' THEN NULL ELSE left(p_message, 500) END)
  ON CONFLICT (from_user_id, to_user_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.connection_requests WHERE from_user_id = v_from AND to_user_id = p_to;
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.request_connection(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_connection(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.request_connection(uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.respond_connection(p_request uuid, p_accept boolean)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_status text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request IS NULL OR p_accept IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  UPDATE public.connection_requests
     SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
         responded_at = now()
   WHERE id = p_request AND to_user_id = v_uid AND status = 'pending'
  RETURNING status INTO v_status;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'no_pending_request' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_status;
END;
$$;
REVOKE ALL ON FUNCTION public.respond_connection(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.respond_connection(uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.respond_connection(uuid, boolean) TO authenticated, service_role;

DO $mig$
BEGIN
  IF to_regclass('public.connection_requests') IS NULL THEN
    RAISE NOTICE 'VTID-05582: public.connection_requests is absent; revoke skipped';
    RETURN;
  END IF;
  REVOKE INSERT, UPDATE ON TABLE public.connection_requests FROM PUBLIC, anon, authenticated;
END
$mig$;

COMMIT;
