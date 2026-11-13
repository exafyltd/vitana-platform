-- VTID-05023: pgTAP-style checks for the allowlist baseline migration
-- (20260917084340_vtid_05023_allowlist_tables_baseline.sql).
-- Run on PGlite through pglite-harness/run.mjs. The harness loads the migration
-- (and fixtures) before this file. Row expectations come from the fixture via
-- session settings; with no fixture both expectations are empty.

SET search_path = public, extensions;

SELECT plan(13);

-- Tables exist.
SELECT has_table('public', 'notification_test_actors', '1 notification_test_actors exists');
SELECT has_table('public', 'service_bot_accounts', '2 service_bot_accounts exists');

-- Columns: name, type, nullability, default. Ordered by position.
SELECT is(
  (SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY ordinal_position)
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notification_test_actors'),
  'user_id:uuid:NO:-,reason:text:NO:-,created_at:timestamp with time zone:NO:now()',
  '3 notification_test_actors columns, types, NOT NULL, defaults');
SELECT is(
  (SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY ordinal_position)
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'service_bot_accounts'),
  'user_id:uuid:NO:-,label:text:NO:-,reason:text:NO:-,created_at:timestamp with time zone:NO:now()',
  '4 service_bot_accounts columns, types, NOT NULL, defaults');

-- Primary keys.
SELECT is(
  (SELECT string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position)
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public' AND tc.table_name = 'notification_test_actors' AND tc.constraint_type = 'PRIMARY KEY'),
  'user_id',
  '5 notification_test_actors primary key is user_id');
SELECT is(
  (SELECT string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position)
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public' AND tc.table_name = 'service_bot_accounts' AND tc.constraint_type = 'PRIMARY KEY'),
  'user_id',
  '6 service_bot_accounts primary key is user_id');

-- RLS enabled on both, no policies on either.
SELECT is((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.notification_test_actors'::regclass), true, '7 notification_test_actors RLS enabled');
SELECT is((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.service_bot_accounts'::regclass), true, '8 service_bot_accounts RLS enabled');
SELECT is((SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('notification_test_actors', 'service_bot_accounts'))::int, 0, '9 no policies on either table');

-- Pre-existing rows survive the baseline (expectations set by the fixture; 0 and none when there is no fixture).
SELECT is((SELECT count(*) FROM public.service_bot_accounts)::int,
          coalesce(nullif(current_setting('vtid_05023.expected_rows', true), ''), '0')::int,
          '10 service_bot_accounts row count unchanged');
SELECT is(coalesce((SELECT label FROM public.service_bot_accounts WHERE user_id = '05023000-0000-4000-8000-0000000000a1'), '-'),
          coalesce(nullif(current_setting('vtid_05023.expected_label', true), ''), '-'),
          '11 fixture row label unchanged');
SELECT is((SELECT count(*) FROM public.notification_test_actors)::int,
          coalesce(nullif(current_setting('vtid_05023.expected_nta_rows', true), ''), '0')::int,
          '12 notification_test_actors row count unchanged');
SELECT is((SELECT count(*) FROM public.service_bot_accounts WHERE user_id = '05023000-0000-4000-8000-0000000000a1')::int,
          coalesce(nullif(current_setting('vtid_05023.expected_fixture_present', true), ''), '0')::int,
          '13 fixture row present only when the fixture inserted it');

SELECT * FROM finish();
