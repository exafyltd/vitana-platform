-- The same four sign-ups on the "aurora" side, through ensure_provisioned()
-- called as service_role (what the gateway's RPC uses). Then every user again:
-- the second round must create nothing and change no row count.
CREATE TABLE public.bridge_results (n serial PRIMARY KEY, user_id uuid, result jsonb);
GRANT ALL ON public.bridge_results, public.bridge_results_n_seq TO service_role;

SET ROLE service_role;
INSERT INTO public.bridge_results (user_id, result) SELECT '10000000-0000-0000-0000-000000000001', public.ensure_provisioned('10000000-0000-0000-0000-000000000001', 'alice@example.com', '{"tenant_slug":"maxina","full_name":"Alice Example"}', now());
INSERT INTO public.bridge_results (user_id, result) SELECT '10000000-0000-0000-0000-000000000002', public.ensure_provisioned('10000000-0000-0000-0000-000000000002', 'bob@example.com', '{}', now());
INSERT INTO public.bridge_results (user_id, result) SELECT '10000000-0000-0000-0000-000000000003', public.ensure_provisioned('10000000-0000-0000-0000-000000000003', 'carol@example.com', '{"tenant_slug":"no-such-tenant","display_name":"Caro"}', now());
INSERT INTO public.bridge_results (user_id, result) SELECT '10000000-0000-0000-0000-000000000004', public.ensure_provisioned('10000000-0000-0000-0000-000000000004', 'dave@example.com', '{"tenant_slug":"alkalma","full_name":"Dave D","display_name":"DD"}', NULL);
RESET ROLE;

CREATE TABLE public.bridge_counts AS
  SELECT 'profiles' AS t, count(*) AS c FROM public.profiles UNION ALL
  SELECT 'global_community_profiles', count(*) FROM public.global_community_profiles UNION ALL
  SELECT 'memberships', count(*) FROM public.memberships UNION ALL
  SELECT 'role_preferences', count(*) FROM public.role_preferences UNION ALL
  SELECT 'user_discount_codes', count(*) FROM public.user_discount_codes UNION ALL
  SELECT 'user_preferences', count(*) FROM public.user_preferences UNION ALL
  SELECT 'wallet_accounts', count(*) FROM public.wallet_accounts UNION ALL
  SELECT 'app_users', count(*) FROM public.app_users UNION ALL
  SELECT 'user_tenants', count(*) FROM public.user_tenants UNION ALL
  SELECT 'user_permitted_roles', count(*) FROM public.user_permitted_roles UNION ALL
  SELECT 'user_journey', count(*) FROM public.user_journey;

SET ROLE service_role;
DO $$
DECLARE r jsonb; u record;
BEGIN
  FOR u IN SELECT DISTINCT b.user_id, p.email FROM public.bridge_results b JOIN public.profiles p USING (user_id) LOOP
    r := public.ensure_provisioned(u.user_id, u.email, '{"tenant_slug":"maxina"}', now());
    IF (r ->> 'provisioned')::boolean OR jsonb_array_length(r -> 'created') <> 0 THEN
      RAISE EXCEPTION 'FAIL: second ensure_provisioned for % created rows: %', u.user_id, r;
    END IF;
  END LOOP;
END $$;
RESET ROLE;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(b.t || ' ' || b.c || ' -> ' || n.c, ', ') INTO bad FROM public.bridge_counts b JOIN (
    SELECT 'profiles' AS t, count(*) AS c FROM public.profiles UNION ALL
    SELECT 'global_community_profiles', count(*) FROM public.global_community_profiles UNION ALL
    SELECT 'memberships', count(*) FROM public.memberships UNION ALL
    SELECT 'role_preferences', count(*) FROM public.role_preferences UNION ALL
    SELECT 'user_discount_codes', count(*) FROM public.user_discount_codes UNION ALL
    SELECT 'user_preferences', count(*) FROM public.user_preferences UNION ALL
    SELECT 'wallet_accounts', count(*) FROM public.wallet_accounts UNION ALL
    SELECT 'app_users', count(*) FROM public.app_users UNION ALL
    SELECT 'user_tenants', count(*) FROM public.user_tenants UNION ALL
    SELECT 'user_permitted_roles', count(*) FROM public.user_permitted_roles UNION ALL
    SELECT 'user_journey', count(*) FROM public.user_journey) n USING (t)
  WHERE b.c <> n.c;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'FAIL: repeat provisioning changed row counts: %', bad; END IF;
  IF (SELECT count(*) FROM public.bridge_results WHERE (result ->> 'provisioned')::boolean) <> 4 THEN
    RAISE EXCEPTION 'FAIL: first round did not report provisioned for all 4 users';
  END IF;
  RAISE NOTICE 'ok: ensure_provisioned is idempotent (second round created nothing)';
END $$;

-- Only the first result per user carries the trigger-equivalent outcome.
CREATE VIEW public.test_active_tenant AS
  SELECT DISTINCT ON (user_id) user_id, result ->> 'active_tenant_id' AS active_tenant_id
  FROM public.bridge_results ORDER BY user_id, n;
