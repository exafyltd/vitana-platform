-- VTID-04888 assertions. Run after the fixture, the migration (twice) and the fix-up (twice).
\set ON_ERROR_STOP 1

-- Fix-up: profiles, intents, recommendations, matches.
DO $$
BEGIN
  ASSERT (SELECT bool_and(NOT is_visible) FROM public.global_community_profiles
           WHERE user_id IN ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1')),
         'excluded profiles must be hidden';
  ASSERT (SELECT bool_and(is_visible) FROM public.global_community_profiles
           WHERE user_id IN ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003')),
         'real profiles stay visible';
  ASSERT (SELECT status FROM public.user_intents WHERE intent_id = '10000000-0000-0000-0000-0000000000a1') = 'closed',
         'excluded intent closed';
  ASSERT (SELECT status FROM public.user_intents WHERE intent_id = '10000000-0000-0000-0000-000000000001') = 'open',
         'real intent untouched';
  ASSERT NOT EXISTS (SELECT 1 FROM public.intent_match_recommendations WHERE intent_id = '10000000-0000-0000-0000-0000000000a1'),
         'excluded intent recommendation deleted';
  ASSERT (SELECT candidates FROM public.intent_match_recommendations WHERE intent_id = '10000000-0000-0000-0000-000000000001')
         = '[{"intent_id":"10000000-0000-0000-0000-000000000002","vitana_id":"V-R2"}]'::jsonb,
         'excluded candidate stripped from a real member''s recommendation';
  ASSERT (SELECT voice_readback IS NULL AND reasoning_summary IS NULL FROM public.intent_match_recommendations
           WHERE intent_id = '10000000-0000-0000-0000-000000000001'), 'rewritten row loses its stale readback';
  ASSERT (SELECT voice_readback FROM public.intent_match_recommendations WHERE intent_id = '10000000-0000-0000-0000-000000000002') = 'r2 readback',
         'untouched recommendation keeps its readback';
  ASSERT (SELECT array_agg(match_id::text ORDER BY match_id) FROM public.intent_matches)
         = ARRAY['20000000-0000-0000-0000-000000000002'], 'only the real match survives';
  ASSERT (SELECT count(*) FROM public.intent_events) = 1, 'the real match keeps its event';
END $$;

-- A NEW open intent by the test actor (the case the RPC predicates exist for).
INSERT INTO public.user_intents (intent_id, requester_user_id, requester_vitana_id, intent_kind, category, status)
VALUES ('10000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', 'V-X', 'activity_seek', 'dance.salsa', 'open');

DO $$
DECLARE ids text[]; pool int;
BEGIN
  -- search v2 / v1 from a real member: R2 found, X and B never; pool count excludes them.
  SELECT array_agg(cand_intent_id::text ORDER BY cand_intent_id), max((reasons->>'pool_size')::int)
    INTO ids, pool
    FROM public.search_intent_catalog_v2('00000000-0000-0000-0000-000000000001', NULL, 'activity_seek', 'dance.salsa', '{}'::jsonb);
  ASSERT ids = ARRAY['10000000-0000-0000-0000-000000000002'], format('search_v2 candidates: %s', ids);
  ASSERT pool = 1, format('search_v2 pool_size: %s', pool);
  SELECT array_agg(cand_intent_id::text ORDER BY cand_intent_id), max((reasons->>'pool_size')::int)
    INTO ids, pool
    FROM public.search_intent_catalog('00000000-0000-0000-0000-000000000001', NULL, 'activity_seek', 'dance.salsa', '{}'::jsonb);
  ASSERT ids = ARRAY['10000000-0000-0000-0000-000000000002'], format('search_v1 candidates: %s', ids);
  ASSERT pool = 1, format('search_v1 pool_size: %s', pool);
  -- searching AS an excluded account returns nothing.
  ASSERT NOT EXISTS (SELECT 1 FROM public.search_intent_catalog_v2('00000000-0000-0000-0000-0000000000a1', NULL, 'activity_seek', 'dance.salsa', '{}'::jsonb)),
         'search_v2 as an excluded account returns nothing';
  ASSERT NOT EXISTS (SELECT 1 FROM public.search_intent_catalog('00000000-0000-0000-0000-0000000000a1', NULL, 'activity_seek', 'dance.salsa', '{}'::jsonb)),
         'search_v1 as an excluded account returns nothing';
END $$;

DO $$
DECLARE n int;
BEGIN
  DELETE FROM public.intent_matches WHERE match_id <> '20000000-0000-0000-0000-000000000002';
  -- compute for R2's intent: only R1 is a candidate (X's new intent excluded).
  n := public.compute_intent_matches_v2('10000000-0000-0000-0000-000000000002', 5);
  ASSERT n = 1, format('compute_v2 inserted %s', n);
  ASSERT NOT EXISTS (SELECT 1 FROM public.intent_matches WHERE intent_b_id = '10000000-0000-0000-0000-0000000000a2'),
         'compute_v2 never pairs with an excluded intent';
  ASSERT (SELECT (match_reasons->>'pool_size')::int FROM public.intent_matches
           WHERE intent_a_id = '10000000-0000-0000-0000-000000000002') = 1, 'compute_v2 pool_size excludes';
  -- compute for the excluded account's own intent: nothing.
  ASSERT public.compute_intent_matches_v2('10000000-0000-0000-0000-0000000000a2', 5) = 0, 'compute_v2 for an excluded source';
  ASSERT public.compute_intent_matches('10000000-0000-0000-0000-0000000000a2', 5) = 0, 'compute_v1 for an excluded source';
  DELETE FROM public.intent_matches WHERE intent_a_id = '10000000-0000-0000-0000-000000000002';
  n := public.compute_intent_matches('10000000-0000-0000-0000-000000000002', 5);
  ASSERT n = 1, format('compute_v1 inserted %s', n);
  ASSERT NOT EXISTS (SELECT 1 FROM public.intent_matches WHERE intent_a_id = '10000000-0000-0000-0000-0000000000a2'
                        OR intent_b_id = '10000000-0000-0000-0000-0000000000a2'), 'compute_v1 never pairs with an excluded intent';
END $$;

-- Backstop: whatever writes intent_matches, an excluded account is never stored.
DO $$
BEGIN
  INSERT INTO public.intent_matches (intent_a_id, intent_b_id, state)
  VALUES ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000a2', 'new');
  INSERT INTO public.intent_matches (intent_a_id, intent_b_id, state)
  VALUES ('10000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000001', 'new');
  INSERT INTO public.intent_matches (intent_a_id, external_target_kind, external_target_id, state)
  VALUES ('10000000-0000-0000-0000-000000000001', 'profile_match', '00000000-0000-0000-0000-0000000000b1', 'new');
  ASSERT NOT EXISTS (SELECT 1 FROM public.intent_matches
                      WHERE intent_a_id = '10000000-0000-0000-0000-0000000000a2' OR intent_b_id = '10000000-0000-0000-0000-0000000000a2'
                         OR external_target_id = '00000000-0000-0000-0000-0000000000b1'), 'backstop skipped every excluded pairing';
  INSERT INTO public.intent_matches (intent_a_id, external_target_kind, external_target_id, state)
  VALUES ('10000000-0000-0000-0000-000000000001', 'profile_match', '00000000-0000-0000-0000-000000000003', 'new');
  ASSERT EXISTS (SELECT 1 FROM public.intent_matches WHERE external_target_id = '00000000-0000-0000-0000-000000000003'),
         'a real profile match is stored';
END $$;

-- Profile visibility trigger, including a member-role update (SECURITY DEFINER path).
SET ROLE authenticated;
UPDATE public.global_community_profiles SET is_visible = true WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
UPDATE public.global_community_profiles SET is_visible = true WHERE user_id = '00000000-0000-0000-0000-000000000001';
RESET ROLE;
DO $$
BEGIN
  ASSERT NOT (SELECT is_visible FROM public.global_community_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1'),
         'an excluded profile cannot be made visible';
  ASSERT (SELECT is_visible FROM public.global_community_profiles WHERE user_id = '00000000-0000-0000-0000-000000000001'),
         'a real profile update is unaffected';
  INSERT INTO public.service_bot_accounts VALUES ('00000000-0000-0000-0000-0000000000b2');
  INSERT INTO public.global_community_profiles (user_id) VALUES ('00000000-0000-0000-0000-0000000000b2');
  ASSERT NOT (SELECT is_visible FROM public.global_community_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000b2'),
         'a new excluded profile is stored hidden';
  -- Listing an account later hides it.
  INSERT INTO public.notification_test_actors VALUES ('00000000-0000-0000-0000-000000000003');
  ASSERT NOT (SELECT is_visible FROM public.global_community_profiles WHERE user_id = '00000000-0000-0000-0000-000000000003'),
         'listing an account hides its profile';
  -- Grants: the helper is not callable by clients.
  ASSERT NOT has_function_privilege('authenticated', 'public.is_excluded_account(uuid)', 'EXECUTE'), 'authenticated cannot probe';
  ASSERT NOT has_function_privilege('anon', 'public.is_excluded_account(uuid)', 'EXECUTE'), 'anon cannot probe';
  ASSERT has_function_privilege('service_role', 'public.is_excluded_account(uuid)', 'EXECUTE'), 'service_role can';
END $$;

\echo 'VTID-04888 rule-45 assertions passed'
