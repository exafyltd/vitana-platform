-- VTID-05041 assertions. Runs after vtid_05041_fixture.sql (live exposure
-- reproduced), the VTID-04981 migration and the VTID-05041 migration (twice).

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.write_fact(uuid,uuid,text,text,text,text,text,uuid,numeric,uuid)',
    'public.get_current_facts(uuid,uuid,text,text[])',
    'public.recall_at_time_range(uuid,timestamptz,timestamptz,text)',
    'public.memory_facts_semantic_search(public.vector,integer,uuid,uuid,text,numeric)',
    'public.fn_consume_credits(uuid,uuid,integer,text,text,text)']
  LOOP
    ASSERT NOT has_function_privilege('authenticated', fn, 'EXECUTE'), 'authenticated cannot execute ' || fn;
    ASSERT NOT has_function_privilege('anon', fn, 'EXECUTE'), 'anon cannot execute ' || fn;
    ASSERT has_function_privilege('service_role', fn, 'EXECUTE'), 'service_role still can execute ' || fn;
  END LOOP;
  ASSERT has_function_privilege('anon', 'public.get_user_profile_by_identifier(text)', 'EXECUTE'), 'anon keeps the profile lookup';
  ASSERT has_function_privilege('authenticated', 'public.get_user_profile_by_identifier(text)', 'EXECUTE'), 'members keep the profile lookup';
  ASSERT has_function_privilege('service_role', 'public.get_user_profile_by_identifier(text)', 'EXECUTE'), 'service_role keeps the profile lookup';
  ASSERT pg_get_function_result('public.get_user_profile_by_identifier(text)'::regprocedure) NOT ILIKE '%email%', 'no email in the return shape';
  ASSERT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_user_profile_by_identifier(text)'::regprocedure), 'still SECURITY DEFINER';
END $$;

-- A member calling any memory function is refused by Postgres.
SET ROLE authenticated;
DO $$
DECLARE
  u uuid := '00000000-0000-0000-0000-0000000050a1';
  t uuid := 'aaaaaaaa-0000-0000-0000-000000000000';
  n integer := 0;
BEGIN
  BEGIN PERFORM public.write_fact(t, u, 'k', 'v'); EXCEPTION WHEN insufficient_privilege THEN n := n + 1; END;
  BEGIN PERFORM public.get_current_facts(t, u); EXCEPTION WHEN insufficient_privilege THEN n := n + 1; END;
  BEGIN PERFORM public.recall_at_time_range(u, now() - interval '1 day', now()); EXCEPTION WHEN insufficient_privilege THEN n := n + 1; END;
  BEGIN PERFORM public.memory_facts_semantic_search(ARRAY[0.1]::public.vector, 5, t, u); EXCEPTION WHEN insufficient_privilege THEN n := n + 1; END;
  BEGIN PERFORM public.fn_consume_credits(t, u, 5, 'purchased_credits', 'match_reveals', 'k'); EXCEPTION WHEN insufficient_privilege THEN n := n + 1; END;
  ASSERT n = 5, format('all five member calls refused (refused %s)', n);
END $$;
RESET ROLE;

-- The gateway (service_role) still calls them.
SET ROLE service_role;
DO $$
DECLARE
  u uuid := '00000000-0000-0000-0000-0000000050a1';
  t uuid := 'aaaaaaaa-0000-0000-0000-000000000000';
BEGIN
  ASSERT public.write_fact(t, u, 'k', 'v') IS NOT NULL, 'service_role write_fact';
  PERFORM public.get_current_facts(t, u);
  PERFORM public.recall_at_time_range(u, now() - interval '1 day', now());
  PERFORM public.memory_facts_semantic_search(ARRAY[0.1]::public.vector, 5, t, u);
  PERFORM public.fn_consume_credits(t, u, 5, 'purchased_credits', 'match_reveals', 'k');
END $$;
RESET ROLE;

-- A visitor (anon) still resolves a visible member, by handle, @handle,
-- vitana_id and UUID, with no email column; a hidden member stays hidden.
SET ROLE anon;
DO $$
DECLARE
  r record;
  ident text;
BEGIN
  FOREACH ident IN ARRAY ARRAY['visible_member', '@visible_member', 'vm0001', '00000000-0000-0000-0000-0000000050a1'] LOOP
    SELECT * INTO r FROM public.get_user_profile_by_identifier(ident);
    ASSERT FOUND, 'anon resolves ' || ident;
    ASSERT r.display_name = 'Visible Member', 'display_name for ' || ident;
    ASSERT NOT (to_jsonb(r) ? 'email'), 'no email key for ' || ident;
    ASSERT r.account_type = 'Community' AND r.verification_status = 'unverified', 'default CASEs unchanged for ' || ident;
  END LOOP;
  PERFORM 1 FROM public.get_user_profile_by_identifier('hidden_member');
  ASSERT NOT FOUND, 'is_visible gate unchanged';
END $$;
RESET ROLE;

\echo 'VTID-05041: all assertions passed'
