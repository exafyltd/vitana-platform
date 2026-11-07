-- VTID-05570 (mt-data-cleanup-r2 / memory-facts-supersede-merge) — pgTAP: supersede-merge of duplicate current
-- memory_facts and its restore (tasks M1, M2, M4).
-- Runs with `supabase test db` (pg_prove) on the local stack, after 20261102041000_vtid_05570_memfacts_merge_functions.sql.
-- The run file (041200) is a thin caller of public.mt_memfacts_merge(), so this test drives the functions directly.
-- One transaction, rolled back at the end. It inserts its OWN rows (own tenant and user uuids) and asserts only on
-- those rows; it never depends on other fixture rows or on absolute counts.
--
-- Covers:
--  * a duplicate group (tenant, user, fact_key, entity) collapses to exactly one current fact, the newest
--    extracted_at wins (id breaks a tie), losers get superseded_by = winner and superseded_at, and nothing is deleted;
--  * a lone fact, an already-superseded row and a 'self' vs 'disclosed' pair of the same key are untouched;
--  * the same key for another user or tenant is its own group;
--  * a second run changes nothing; restore reinstates the duplicates; a restore without a snapshot is a no-op;
--  * nothing here is executable by anon/authenticated.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(29);

-- Fixture ---------------------------------------------------------------------------------------
-- Tenants TA/TB, users UA/UB. Ids are fixed so assertions name their own rows.
--  A1..A3  group (TA,UA,'diet','self')           A1 oldest, A2 newest (winner), A3 middle
--  B1..B2  group (TA,UA,'sleep','self')          same extracted_at -> larger id wins (B2)
--  C1      lone fact (TA,UA,'city','self')
--  D1      (TA,UA,'diet','disclosed')            same key as A*, other entity -> own group, lone
--  E1..E2  group (TA,UB,'diet','self')           other user, same key -> own group, E2 newest
--  F1..F2  group (TB,UA,'diet','self')           other tenant, same key -> own group, F1 newest
--  G1,G2   (TA,UA,'age','self') G1 already superseded by G2, G2 current -> untouched
--  H1..H3  group (TA,UA,'pet','self')            H1 already superseded (by H3), H2 and H3 current duplicates, H3 newest
CREATE TEMP TABLE t05570 (k text PRIMARY KEY, v uuid NOT NULL);
INSERT INTO t05570 VALUES
  ('TA','05570000-0000-4000-8000-0000000000a1'),('TB','05570000-0000-4000-8000-0000000000a2'),
  ('UA','05570000-0000-4000-8000-0000000000b1'),('UB','05570000-0000-4000-8000-0000000000b2'),
  ('A1','05570000-0000-4000-8000-000000000011'),('A2','05570000-0000-4000-8000-000000000012'),('A3','05570000-0000-4000-8000-000000000013'),
  ('B1','05570000-0000-4000-8000-000000000021'),('B2','05570000-0000-4000-8000-000000000022'),
  ('C1','05570000-0000-4000-8000-000000000031'),('D1','05570000-0000-4000-8000-000000000041'),
  ('E1','05570000-0000-4000-8000-000000000051'),('E2','05570000-0000-4000-8000-000000000052'),
  ('F1','05570000-0000-4000-8000-000000000061'),('F2','05570000-0000-4000-8000-000000000062'),
  ('G1','05570000-0000-4000-8000-000000000071'),('G2','05570000-0000-4000-8000-000000000072'),
  ('H1','05570000-0000-4000-8000-000000000081'),('H2','05570000-0000-4000-8000-000000000082'),('H3','05570000-0000-4000-8000-000000000083');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT v FROM t05570 WHERE k = p $$;

INSERT INTO public.memory_facts (id, tenant_id, user_id, entity, fact_key, fact_value, extracted_at) VALUES
  (pg_temp.id('A1'), pg_temp.id('TA'), pg_temp.id('UA'), 'self',      'diet',  'vegan',    '2026-01-01 10:00+00'),
  (pg_temp.id('A2'), pg_temp.id('TA'), pg_temp.id('UA'), 'self',      'diet',  'keto',     '2026-03-01 10:00+00'),
  (pg_temp.id('A3'), pg_temp.id('TA'), pg_temp.id('UA'), 'self',      'diet',  'paleo',    '2026-02-01 10:00+00'),
  (pg_temp.id('B1'), pg_temp.id('TA'), pg_temp.id('UA'), 'self',      'sleep', '6h',       '2026-01-05 10:00+00'),
  (pg_temp.id('B2'), pg_temp.id('TA'), pg_temp.id('UA'), 'self',      'sleep', '7h',       '2026-01-05 10:00+00'),
  (pg_temp.id('C1'), pg_temp.id('TA'), pg_temp.id('UA'), 'self',      'city',  'Berlin',   '2026-01-06 10:00+00'),
  (pg_temp.id('D1'), pg_temp.id('TA'), pg_temp.id('UA'), 'disclosed', 'diet',  'omnivore', '2026-01-07 10:00+00'),
  (pg_temp.id('E1'), pg_temp.id('TA'), pg_temp.id('UB'), 'self',      'diet',  'a',        '2026-01-08 10:00+00'),
  (pg_temp.id('E2'), pg_temp.id('TA'), pg_temp.id('UB'), 'self',      'diet',  'b',        '2026-01-09 10:00+00'),
  (pg_temp.id('F1'), pg_temp.id('TB'), pg_temp.id('UA'), 'self',      'diet',  'c',        '2026-01-10 10:00+00'),
  (pg_temp.id('F2'), pg_temp.id('TB'), pg_temp.id('UA'), 'self',      'diet',  'd',        '2026-01-04 10:00+00'),
  (pg_temp.id('G1'), pg_temp.id('TA'), pg_temp.id('UA'), 'self',      'age',   '40',       '2026-01-01 10:00+00'),
  (pg_temp.id('G2'), pg_temp.id('TA'), pg_temp.id('UA'), 'self',      'age',   '41',       '2026-01-02 10:00+00'),
  (pg_temp.id('H1'), pg_temp.id('TA'), pg_temp.id('UA'), 'self',      'pet',   'none',     '2026-01-01 10:00+00'),
  (pg_temp.id('H2'), pg_temp.id('TA'), pg_temp.id('UA'), 'self',      'pet',   'cat',      '2026-01-02 10:00+00'),
  (pg_temp.id('H3'), pg_temp.id('TA'), pg_temp.id('UA'), 'self',      'pet',   'dog',      '2026-01-03 10:00+00');
-- Pre-existing supersede state (the write_fact mechanism): G1 -> G2, H1 -> H3.
UPDATE public.memory_facts SET superseded_by = pg_temp.id('G2'), superseded_at = '2026-01-02 11:00+00' WHERE id = pg_temp.id('G1');
UPDATE public.memory_facts SET superseded_by = pg_temp.id('H3'), superseded_at = '2026-01-03 11:00+00' WHERE id = pg_temp.id('H1');

CREATE FUNCTION pg_temp.cur(p_k text) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT superseded_by IS NULL FROM public.memory_facts WHERE id = pg_temp.id(p_k) $$;
CREATE FUNCTION pg_temp.sup(p_k text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT superseded_by FROM public.memory_facts WHERE id = pg_temp.id(p_k) $$;
CREATE FUNCTION pg_temp.fixture_state() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT string_agg(id::text || ':' || coalesce(superseded_by::text, '-') || ':' || coalesce(superseded_at::text, '-'), ',' ORDER BY id)
       FROM public.memory_facts WHERE id IN (SELECT v FROM t05570 WHERE k ~ '^[A-H][0-9]$') $$;

SELECT ok(true, 'fixture loaded (' || (SELECT count(*) FROM public.memory_facts WHERE tenant_id IN (pg_temp.id('TA'), pg_temp.id('TB'))) || ' rows)');

-- Before the merge ------------------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM public.memory_facts
            WHERE tenant_id = pg_temp.id('TA') AND user_id = pg_temp.id('UA') AND fact_key = 'diet' AND entity = 'self' AND superseded_by IS NULL),
          3, 'before: group A has 3 current facts');
SELECT ok(NOT has_function_privilege('anon', 'public.mt_memfacts_merge()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.mt_memfacts_merge()', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.mt_memfacts_merge()', 'EXECUTE'),
          'mt_memfacts_merge() is service_role only');
SELECT ok(NOT has_function_privilege('anon', 'public.mt_memfacts_restore()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.mt_memfacts_restore()', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.mt_memfacts_restore()', 'EXECUTE'),
          'mt_memfacts_restore() is service_role only');

-- A restore before any merge changes none of the fixture rows -------------------------------------
CREATE TEMP TABLE t05570_state (label text PRIMARY KEY, s text);
INSERT INTO t05570_state VALUES ('before', pg_temp.fixture_state());
SELECT lives_ok($$SELECT public.mt_memfacts_restore()$$, 'restore with no snapshot yet does not fail');
SELECT is(pg_temp.fixture_state(), (SELECT s FROM t05570_state WHERE label = 'before'), 'restore with no snapshot changes nothing');

-- First merge -------------------------------------------------------------------------------------
CREATE TEMP TABLE t05570_res (label text PRIMARY KEY, r jsonb);
INSERT INTO t05570_res SELECT 'merge1', public.mt_memfacts_merge();
SELECT ok((SELECT (r ->> 'groups')::int >= 5 AND (r ->> 'superseded')::int >= 6 FROM t05570_res WHERE label = 'merge1'),
          'merge reports at least this fixture''s 5 groups and 6 superseded rows');

SELECT is((SELECT count(*)::int FROM public.memory_facts
            WHERE tenant_id = pg_temp.id('TA') AND user_id = pg_temp.id('UA') AND fact_key = 'diet' AND entity = 'self' AND superseded_by IS NULL),
          1, 'group A collapses to one current fact');
SELECT ok(pg_temp.cur('A2'), 'group A: the newest extracted_at (A2) stays current');
SELECT is(pg_temp.sup('A1'), pg_temp.id('A2'), 'group A: A1 is superseded by the winner');
SELECT is(pg_temp.sup('A3'), pg_temp.id('A2'), 'group A: A3 is superseded by the winner');
SELECT ok((SELECT bool_and(superseded_at IS NOT NULL) FROM public.memory_facts WHERE id IN (pg_temp.id('A1'), pg_temp.id('A3'))),
          'group A: losers carry superseded_at');
SELECT is((SELECT count(*)::int FROM public.memory_facts WHERE id IN (pg_temp.id('A1'), pg_temp.id('A2'), pg_temp.id('A3'))),
          3, 'group A: no row was deleted');
SELECT is((SELECT fact_value FROM public.memory_facts WHERE id = pg_temp.id('A1')), 'vegan', 'group A: a loser keeps its value');

SELECT ok(pg_temp.cur('B2') AND pg_temp.sup('B1') = pg_temp.id('B2'), 'group B: equal extracted_at, the larger id wins');
SELECT ok(pg_temp.cur('C1'), 'a lone fact stays current');
SELECT ok(pg_temp.cur('D1') AND pg_temp.cur('A2'), 'self and disclosed facts of the same key are not merged');
SELECT ok(pg_temp.cur('E2') AND pg_temp.sup('E1') = pg_temp.id('E2'), 'another user''s group merges on its own (E2 wins)');
SELECT ok(pg_temp.cur('F1') AND pg_temp.sup('F2') = pg_temp.id('F1'), 'another tenant''s group merges on its own (F1 wins)');
SELECT ok(pg_temp.sup('G1') = pg_temp.id('G2') AND pg_temp.cur('G2')
      AND (SELECT superseded_at FROM public.memory_facts WHERE id = pg_temp.id('G1')) = '2026-01-02 11:00+00',
          'an already-superseded row and its current successor are untouched');
SELECT ok(pg_temp.cur('H3') AND pg_temp.sup('H2') = pg_temp.id('H3'), 'group H: current duplicates merge, newest (H3) wins');
SELECT ok(pg_temp.sup('H1') = pg_temp.id('H3')
      AND (SELECT superseded_at FROM public.memory_facts WHERE id = pg_temp.id('H1')) = '2026-01-03 11:00+00',
          'group H: the row superseded before the merge keeps its original superseded_by and superseded_at');

-- No group of this fixture has more than one current fact.
SELECT is((SELECT count(*)::int FROM (
             SELECT 1 FROM public.memory_facts
              WHERE superseded_by IS NULL AND tenant_id IN (pg_temp.id('TA'), pg_temp.id('TB'))
              GROUP BY tenant_id, user_id, fact_key, entity HAVING count(*) > 1) d),
          0, 'after: no (tenant,user,fact_key,entity) group has more than one current fact');

-- Second run is a no-op ---------------------------------------------------------------------------
INSERT INTO t05570_state VALUES ('merged', pg_temp.fixture_state());
INSERT INTO t05570_res SELECT 'merge2', public.mt_memfacts_merge();
SELECT is(pg_temp.fixture_state(), (SELECT s FROM t05570_state WHERE label = 'merged'), 'a second merge changes none of the fixture rows');
SELECT is((SELECT (r ->> 'superseded')::int FROM t05570_res WHERE label = 'merge2'), 0, 'a second merge supersedes nothing');

-- Restore -----------------------------------------------------------------------------------------
INSERT INTO t05570_res SELECT 'restore', public.mt_memfacts_restore();
SELECT is(pg_temp.fixture_state(), (SELECT s FROM t05570_state WHERE label = 'before'), 'restore returns every fixture row to its pre-merge state');
SELECT is((SELECT count(*)::int FROM public.memory_facts
            WHERE tenant_id = pg_temp.id('TA') AND user_id = pg_temp.id('UA') AND fact_key = 'diet' AND entity = 'self' AND superseded_by IS NULL),
          3, 'restore reinstates the group A duplicates');

-- Merge after restore works again (the snapshot keeps the first capture) --------------------------
SELECT lives_ok($$SELECT public.mt_memfacts_merge()$$, 'merge after a restore runs');
SELECT ok(pg_temp.cur('A2') AND pg_temp.sup('A1') = pg_temp.id('A2'), 'merge after a restore collapses group A again');

SELECT * FROM finish();
ROLLBACK;
