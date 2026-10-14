-- VTID-05163: the Vitana Index projection (Aurora only) — the FUNCTIONAL DRIFT
-- GUARD of plan Change 10, the key-class routing, STABLE, grants, the
-- vitana_index_dual_compute table and erase_user_data() discovery of all five
-- of B's tables. Runs on a throwaway local Postgres shaped like Aurora (roles +
-- auth.uid() shim + auth.users stub; NO storage.objects). Never run against a
-- shared or production database.
-- Run: scripts/ci/sql-tests/run-index-dual-compute-test.sh (it extracts the LIVE
-- Index functions from the newest migration that defines each, into :live_fns).
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
alter role service_role bypassrls;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$f$;
create table if not exists auth.users (id uuid primary key);
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- ── The tables the live Index reads/writes (only the columns it uses). ──────
create table public.user_tenants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  active_role text not null default 'community',
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create table public.vitana_index_baseline_survey (user_id uuid primary key, answers jsonb not null);
create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  completion_status text,
  completed_at timestamptz,
  end_time timestamptz,
  wellness_tags text[] not null default '{}'
);
create table public.vitana_index_config (id serial primary key, version int not null, is_active boolean not null, pillar_weights jsonb);
create table public.vitana_index_scores (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, user_id uuid not null, date date not null,
  score_total int, score_nutrition int, score_hydration int, score_exercise int, score_sleep int, score_mental int,
  model_version text, feature_inputs jsonb, confidence numeric,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, user_id, date)
);
-- health_features_daily: the union of VTID-01078, VTID-01103 and the 2026-04-23 repair.
create table public.health_features_daily (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, user_id uuid not null, date date not null, feature_key text not null,
  feature_value numeric not null, feature_unit text, sample_count integer default 0, confidence numeric default 1.0,
  metadata jsonb default '{}'::jsonb, provenance jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, user_id, date, feature_key)
);

-- ── The LIVE Index functions, verbatim from their newest migrations. ────────
\i :live_fns

-- ── B1 health_sources + erase_user_data (for the erasure section). ──────────
create or replace function public.upsert_knowledge_doc(p_title text, p_path text, p_source_type text, p_tags text[], p_content text) returns uuid language sql as $f$ select null::uuid $f$;
\o /dev/null
\ir ../../../supabase/migrations/20260417000000_vtid_02100_connector_framework.sql
\ir ../../../supabase/migrations/20260417000100_vtid_02100_connector_registry_seed.sql
\ir ../../../supabase/migrations/20260417010000_vtid_02100_connector_registry_update.sql
\ir ../../../supabase/migrations/20260423200000_vitana_integrations_v1.sql
\ir ../../../supabase/migrations/20261001120000_vtid_04765_erase_user_data.sql
\ir ../../../supabase/migrations/20261014100000_vtid_05158_erase_user_data_aurora_safe.sql
\ir ../../../supabase/migrations/20261014100200_vtid_05161_health_sources.sql
-- B2, then B3 twice (idempotent).
\ir ../../../supabase/migrations/20261014100700_vtid_05162_health_features_v2.sql
\ir ../../../supabase/migrations/20261014100800_vtid_05163_index_dual_compute.sql
\ir ../../../supabase/migrations/20261014100800_vtid_05163_index_dual_compute.sql
\o

-- ── Fixture helpers (member U in tenant T). ──────────────────────────────────
create table t_seen (what text, val text, primary key (what, val));
create or replace function t_u() returns uuid language sql immutable as $f$ select 'a0000000-0000-0000-0000-00000000000a'::uuid $f$;
create or replace function t_t() returns uuid language sql immutable as $f$ select '10000000-0000-0000-0000-000000000001'::uuid $f$;
insert into public.user_tenants (tenant_id, user_id, is_primary) values (t_t(), t_u(), true);

create or replace function t_reset() returns void language plpgsql as $f$ begin
  delete from public.health_features_daily; delete from public.health_features_daily_v2;
  delete from public.calendar_events; delete from public.vitana_index_baseline_survey;
  delete from public.vitana_index_config; delete from public.vitana_index_scores;
end $f$;
-- The same feature row into BOTH tables (the drift guard's premise).
create or replace function t_feat(p_days_ago int, p_key text, p_tenant uuid default null) returns void language plpgsql as $f$ begin
  insert into public.health_features_daily (tenant_id, user_id, date, feature_key, feature_value)
    values (coalesce(p_tenant, t_t()), t_u(), current_date - p_days_ago, p_key, 1) on conflict do nothing;
  insert into public.health_features_daily_v2 (tenant_id, user_id, date, feature_key, feature_value, derivation_version)
    values (coalesce(p_tenant, t_t()), t_u(), current_date - p_days_ago, p_key, 1, 'b2.1') on conflict do nothing;
end $f$;
-- n distinct (date, key) rows inside the 7-day window, spread over the keys.
create or replace function t_feat_n(p_keys text[], p_n int) returns void language plpgsql as $f$
declare i int := 0; d int; k text; begin
  for d in 0..7 loop foreach k in array p_keys loop
    exit when i >= p_n; perform t_feat(d, k); i := i + 1;
  end loop; end loop;
end $f$;
create or replace function t_streak(p_key text, p_days int, p_from int default 0) returns void language plpgsql as $f$
declare d int; begin for d in p_from..(p_from + p_days - 1) loop perform t_feat(d, p_key); end loop; end $f$;
create or replace function t_cal(p_days_ago int, p_tags text[]) returns void language sql as $f$
  insert into public.calendar_events (user_id, completion_status, completed_at, end_time, wellness_tags)
  values (t_u(), 'completed', (current_date - p_days_ago) + time '12:00', (current_date - p_days_ago) + time '13:00', p_tags)
$f$;

-- The drift guard: live == projection for every (p_device_from, p_self_from)
-- with D0/D0s NULL, before, inside and after the fixture window.
create or replace function t_check(p_label text) returns void language plpgsql as $f$
declare
  live jsonb; proj jsonb; d0 date; ds date; i int; j int; p text;
  pos date[] := array[null::date, current_date - 120, current_date - 3, current_date + 3];
begin
  live := public.health_compute_vitana_index_for_user(t_u(), current_date);
  if not coalesce((live ->> 'ok')::boolean, false) then raise exception 'FAIL [%]: live compute failed: %', p_label, live; end if;
  for i in 1..4 loop for j in 1..4 loop
    d0 := pos[i]; ds := pos[j];
    proj := public.vitana_index_project_for_user(t_u(), d0, ds);
    if (live -> 'score_total') is distinct from (proj -> 'score_total')
       or (live -> 'score_nutrition') is distinct from (proj -> 'score_nutrition')
       or (live -> 'score_hydration') is distinct from (proj -> 'score_hydration')
       or (live -> 'score_exercise') is distinct from (proj -> 'score_exercise')
       or (live -> 'score_sleep') is distinct from (proj -> 'score_sleep')
       or (live -> 'score_mental') is distinct from (proj -> 'score_mental')
       or (live -> 'balance_factor') is distinct from (proj -> 'balance_factor')
       or (live -> 'subscores') is distinct from (proj -> 'subscores')
       or (live -> 'confidence') is distinct from (proj -> 'confidence') then
      raise exception 'FAIL drift guard [%] (device_from %, self_from %): live % <> projection %', p_label, d0, ds, live, proj;
    end if;
  end loop; end loop;
  insert into t_seen values ('balance', live ->> 'balance_factor') on conflict do nothing;
  foreach p in array array['nutrition','hydration','exercise','sleep','mental'] loop
    insert into t_seen values ('data', live -> 'subscores' -> p ->> 'data') on conflict do nothing;
    insert into t_seen values ('streak', live -> 'subscores' -> p ->> 'streak') on conflict do nothing;
  end loop;
end $f$;

-- ── 1. The fixture matrix. ───────────────────────────────────────────────────
do $$
declare n int; k text; p text; keys text[];
  pillar_keys jsonb := '{"nutrition":["biomarker_glucose","biomarker_hba1c","meal_log","macro_balance"],
                         "hydration":["water_intake","hydration_log"],
                         "exercise":["wearable_heart_rate","wearable_steps","wearable_workout","vo2_max"],
                         "sleep":["wearable_sleep_duration","wearable_sleep_efficiency","wearable_hrv","wearable_sleep_stages"],
                         "mental":["wearable_stress","mood_entry","meditation_minutes","journal_entry"]}';
begin
  perform t_reset(); perform t_check('empty');

  -- every one of the 18 keys alone, then each pillar alone, then all together
  for p in select jsonb_object_keys(pillar_keys) loop
    for k in select jsonb_array_elements_text(pillar_keys -> p) loop
      perform t_reset(); perform t_feat(0, k); perform t_check('key ' || k);
    end loop;
    perform t_reset();
    for k in select jsonb_array_elements_text(pillar_keys -> p) loop perform t_feat(1, k); end loop;
    perform t_check('pillar ' || p);
  end loop;
  perform t_reset();
  for p in select jsonb_object_keys(pillar_keys) loop
    for k in select jsonb_array_elements_text(pillar_keys -> p) loop perform t_feat(2, k); end loop;
  end loop;
  perform t_check('all pillars');

  -- data-count band edges (0, 1, 3, 4, 10, 11 rows in 7 days)
  foreach n in array array[0, 1, 3, 4, 10, 11] loop
    foreach p in array array['nutrition', 'exercise', 'sleep', 'mental'] loop
      select array_agg(x) into keys from jsonb_array_elements_text(pillar_keys -> p) x;
      perform t_reset(); perform t_feat_n(keys, n); perform t_check(format('band %s rows %s', p, n));
    end loop;
    perform t_reset(); perform t_feat_n(array['water_intake','hydration_log'], n); perform t_check(format('band hydration rows %s', n));
  end loop;

  -- streak edges, carried by features
  foreach n in array array[0, 6, 7, 13, 14, 29, 30, 89, 90, 95] loop
    perform t_reset(); perform t_streak('wearable_steps', n); perform t_check(format('streak %s days', n));
  end loop;
  perform t_reset(); perform t_streak('meal_log', 10); perform t_streak('meal_log', 30, 11); perform t_check('streak with a one-day gap');
  perform t_reset(); perform t_streak('wearable_hrv', 5, 1); perform t_check('streak broken today');
  -- carried only by calendar completions, only by features, and mixed
  perform t_reset();
  for n in 0..13 loop perform t_cal(n, array[(array['sleep','rest','recovery'])[n % 3 + 1]]); end loop;
  perform t_check('streak calendar only');
  perform t_reset(); perform t_streak('mood_entry', 30); perform t_check('streak features only');
  perform t_reset();
  for n in 0..29 loop
    if n % 2 = 0 then perform t_cal(n, array['water']); else perform t_feat(n, 'water_intake'); end if;
  end loop;
  perform t_check('streak alternating calendar / features');

  -- empty days inside the window, rows exactly 7 and 8 days old, a future row,
  -- the same key/day under two tenants
  perform t_reset(); perform t_feat(0, 'wearable_steps'); perform t_feat(5, 'wearable_steps'); perform t_check('empty days inside the window');
  perform t_reset(); perform t_feat(7, 'meal_log'); perform t_check('row exactly 7 days old');
  perform t_reset(); perform t_feat(8, 'meal_log'); perform t_check('row 8 days old');
  perform t_reset(); perform t_feat(-1, 'water_intake'); perform t_check('row dated tomorrow');
  perform t_reset(); perform t_feat(0, 'mood_entry'); perform t_feat(0, 'mood_entry', '20000000-0000-0000-0000-000000000002'::uuid);
  perform t_check('same key and day under two tenants');

  -- baseline survey, completions (tagged and the +1 halo), non-default weights
  perform t_reset(); perform t_feat(0, 'wearable_steps'); perform t_check('no baseline survey');
  perform t_reset();
  insert into public.vitana_index_baseline_survey values (t_u(), '{"nutrition":5,"hydration":4,"exercise":3,"sleep":2,"mental":1}');
  perform t_feat(0, 'wearable_steps'); perform t_cal(1, array['meal']); perform t_cal(2, array['onboarding']); perform t_cal(40, array['meal']);
  perform t_cal(3, array['match']); perform t_cal(4, array['leadership', 'sleep']);
  perform t_check('baseline + completions');
  perform t_reset();
  insert into public.vitana_index_config (version, is_active, pillar_weights) values (1, true, '{"nutrition":1.5,"hydration":0.5,"exercise":1.2,"sleep":0.8}');
  insert into public.vitana_index_config (version, is_active, pillar_weights) values (2, false, '{"nutrition":9}');
  perform t_feat_n(array['meal_log','macro_balance'], 6); perform t_streak('wearable_sleep_duration', 20);
  perform t_check('non-default weights');

  -- every balance-factor band (ratio >= 0.70, >= 0.50, >= 0.30, < 0.30)
  perform t_reset(); insert into public.vitana_index_baseline_survey values (t_u(), '{"nutrition":5,"hydration":5,"exercise":5,"sleep":5,"mental":5}');
  perform t_check('balance >= 0.70');
  perform t_reset(); insert into public.vitana_index_baseline_survey values (t_u(), '{"nutrition":5,"hydration":5,"exercise":5,"sleep":5,"mental":5}');
  perform t_feat_n(array['meal_log','macro_balance','biomarker_glucose','biomarker_hba1c'], 11);
  perform t_check('balance 0.50');
  perform t_reset(); insert into public.vitana_index_baseline_survey values (t_u(), '{"nutrition":5,"hydration":2,"exercise":5,"sleep":5,"mental":5}');
  perform t_feat_n(array['meal_log','macro_balance','biomarker_glucose','biomarker_hba1c'], 11);
  perform t_check('balance 0.30');
  perform t_reset(); insert into public.vitana_index_baseline_survey values (t_u(), '{"nutrition":5,"hydration":1,"exercise":5,"sleep":5,"mental":5}');
  perform t_feat_n(array['meal_log','macro_balance','biomarker_glucose','biomarker_hba1c'], 11); perform t_streak('meal_log', 30);
  perform t_check('balance < 0.30');
  -- ratio exactly 0.30 (hydration 20+6+1 = 27, nutrition 40+1+24+25 = 90): the 0.80 band's lower edge
  perform t_reset(); insert into public.vitana_index_baseline_survey values (t_u(), '{"nutrition":5,"hydration":2,"exercise":5,"sleep":5,"mental":5}');
  perform t_cal(1, array['water']); perform t_cal(2, array['onboarding']);
  for n in 10..13 loop perform t_cal(n, array['meal']); end loop;
  perform t_streak('meal_log', 4);
  if (public.health_compute_vitana_index_for_user(t_u(), current_date) ->> 'balance_factor') <> '0.80' then
    raise exception 'FAIL: the exact-0.30 fixture is not at the band edge'; end if;
  perform t_check('balance exactly 0.30');
end $$;

-- The matrix really reached every band (so the guard compared something).
do $$ begin
  if (select array_agg(val order by val) from t_seen where what = 'balance') is distinct from array['0.70','0.80','0.90','1.00'] then
    raise exception 'FAIL: balance bands seen: %', (select array_agg(val order by val) from t_seen where what = 'balance'); end if;
  if (select array_agg(val::int order by val::int) from t_seen where what = 'data') is distinct from array[0,15,25,40] then
    raise exception 'FAIL: data bands seen: %', (select array_agg(val order by val) from t_seen where what = 'data'); end if;
  if (select array_agg(val::int order by val::int) from t_seen where what = 'streak') is distinct from array[0,15,25,40] then
    raise exception 'FAIL: streak bands seen: %', (select array_agg(val order by val) from t_seen where what = 'streak'); end if;
end $$;
\echo 'PASS vtid-05163 drift guard (fixture matrix x 16 start-date pairs)'

-- ── 2. Key-class routing: different rows in the two tables. ──────────────────
do $$
declare
  n int; j jsonb;
  t uuid := t_t(); u uuid := t_u();
  c date := current_date;
begin
  perform t_reset();
  -- legacy: steps today and 5 days ago, meal today, glucose today; v2: steps 0..4, hrv today, meal 0..3, glucose 0..10
  insert into public.health_features_daily (tenant_id, user_id, date, feature_key, feature_value) values
    (t, u, c, 'wearable_steps', 1), (t, u, c - 5, 'wearable_steps', 1), (t, u, c, 'meal_log', 1), (t, u, c, 'biomarker_glucose', 1);
  insert into public.health_features_daily_v2 (tenant_id, user_id, date, feature_key, feature_value, derivation_version)
    select t, u, c - d, 'wearable_steps', 1, 'b2.1' from generate_series(0, 4) d
    union all select t, u, c, 'wearable_hrv', 1, 'b2.1'
    union all select t, u, c - d, 'meal_log', 1, 'b2.1' from generate_series(0, 3) d
    union all select t, u, c - d, 'biomarker_glucose', 1, 'b2.1' from generate_series(0, 10) d;

  -- (NULL, NULL): legacy only.
  select count(*) into n from public.vitana_index_projected_feature_rows(u, null, null);
  if n <> 4 then raise exception 'FAIL: (NULL,NULL) rows %', n; end if;
  -- (D0, NULL), D0 far back: device keys from v2 (5 steps + 1 hrv), everything else legacy (meal 1, glucose 1).
  select count(*) into n from public.vitana_index_projected_feature_rows(u, c - 30, null);
  if n <> 8 then raise exception 'FAIL: (D0,NULL) rows %', n; end if;
  select count(*) into n from public.vitana_index_projected_feature_rows(u, c - 30, null) where feature_key = 'meal_log';
  if n <> 1 then raise exception 'FAIL: (D0,NULL) took meal_log from v2 (%)', n; end if;
  -- (D0, D0s): coded self-logged keys from v2 from D0s on; glucose (no code) always legacy.
  select count(*) into n from public.vitana_index_projected_feature_rows(u, c - 30, c - 30) where feature_key = 'meal_log';
  if n <> 4 then raise exception 'FAIL: (D0,D0s) meal_log rows %', n; end if;
  select count(*) into n from public.vitana_index_projected_feature_rows(u, c - 30, c - 30) where feature_key = 'biomarker_glucose';
  if n <> 1 then raise exception 'FAIL: biomarker_glucose not always legacy (%)', n; end if;
  -- D0 inside the window: v2 from D0 on (steps 0..2), legacy before (steps 5 days ago).
  select count(*) into n from public.vitana_index_projected_feature_rows(u, c - 2, null) where feature_key = 'wearable_steps';
  if n <> 4 then raise exception 'FAIL: D0 split rows %', n; end if;
  -- D0s alone (D0 NULL): device keys stay legacy.
  select count(*) into n from public.vitana_index_projected_feature_rows(u, null, c - 30) where feature_key = 'wearable_steps';
  if n <> 2 then raise exception 'FAIL: (NULL,D0s) took device rows from v2 (%)', n; end if;

  -- The same split reaches the sub-scores: exercise data 15 (2 legacy rows... 1 in window) vs 25 (5 v2 rows).
  j := public.vitana_index_project_for_user(u, null, null);
  if (j -> 'subscores' -> 'exercise' ->> 'data')::int <> 15 then raise exception 'FAIL: legacy exercise data %', j; end if;
  j := public.vitana_index_project_for_user(u, c - 30, null);
  if (j -> 'subscores' -> 'exercise' ->> 'data')::int <> 25 then raise exception 'FAIL: device-scope exercise data %', j; end if;
  if (j -> 'subscores' -> 'nutrition' ->> 'data')::int <> 15 then raise exception 'FAIL: device-scope nutrition data %', j; end if;
  j := public.vitana_index_project_for_user(u, c - 30, c - 30);
  if (j -> 'subscores' -> 'nutrition' ->> 'data')::int <> 25 then raise exception 'FAIL: full-scope nutrition data %', j; end if;
end $$;
\echo 'PASS vtid-05163 key-class routing'

-- ── 3. STABLE, read-only, grants. ────────────────────────────────────────────
do $$
declare v_n int; ok boolean;
begin
  select count(*) into v_n from pg_proc where pronamespace = 'public'::regnamespace and provolatile = 's' and prosecdef
    and proname in ('vitana_index_project_for_user', 'vitana_pillar_streak_days_projected', 'vitana_index_projected_feature_rows');
  if v_n <> 3 then raise exception 'FAIL: % of 3 projection functions are STABLE SECURITY DEFINER', v_n; end if;
  -- A write inside a STABLE plpgsql function raises (the guarantee the projection relies on).
  execute $q$create function t_stable_write() returns void language plpgsql stable as $b$ begin
    insert into public.vitana_index_scores (tenant_id, user_id, date) values (t_t(), t_u(), current_date); end $b$ $q$;
  begin
    perform t_stable_write();
    raise exception 'FAIL: a STABLE function wrote';
  exception when others then
    if sqlerrm not like '%not allowed in a non-volatile function%' then raise; end if;
  end;
  -- Calling the projection leaves vitana_index_scores untouched.
  delete from public.vitana_index_scores;
  perform public.vitana_index_project_for_user(t_u(), null, null);
  if (select count(*) from public.vitana_index_scores) <> 0 then raise exception 'FAIL: the projection wrote a score row'; end if;
  foreach ok in array array[
    has_function_privilege('anon', 'public.vitana_index_project_for_user(uuid,date,date)', 'execute'),
    has_function_privilege('authenticated', 'public.vitana_index_project_for_user(uuid,date,date)', 'execute'),
    has_function_privilege('authenticated', 'public.vitana_pillar_streak_days_projected(uuid,text,date,date)', 'execute'),
    has_function_privilege('authenticated', 'public.vitana_index_projected_feature_rows(uuid,date,date)', 'execute'),
    has_table_privilege('anon', 'public.vitana_index_dual_compute', 'select'),
    has_table_privilege('authenticated', 'public.vitana_index_dual_compute', 'select'),
    has_table_privilege('authenticated', 'public.vitana_index_dual_compute', 'insert')] loop
    if ok then raise exception 'FAIL: a browser role can reach the projection or the dual-compute table'; end if;
  end loop;
  if not has_function_privilege('service_role', 'public.vitana_index_project_for_user(uuid,date,date)', 'execute')
     or not has_table_privilege('service_role', 'public.vitana_index_dual_compute', 'insert') then
    raise exception 'FAIL: service_role lost access'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.vitana_index_dual_compute'::regclass) then
    raise exception 'FAIL: RLS off on vitana_index_dual_compute'; end if;
end $$;
\echo 'PASS vtid-05163 stable + grants'

-- ── 4. vitana_index_dual_compute shape. ──────────────────────────────────────
do $$ begin
  insert into public.vitana_index_dual_compute (tenant_id, user_id, date, scope, live_total, legacy_total, v2_total, diff_class, formula_ok)
    values (t_t(), t_u(), current_date, 'device', 300, 300, 310, '{derivation_pending}', true);
  begin
    insert into public.vitana_index_dual_compute (tenant_id, user_id, date, scope) values (t_t(), t_u(), current_date, 'device');
    raise exception 'FAIL: duplicate (member, date, scope) accepted';
  exception when unique_violation then null; end;
  begin
    insert into public.vitana_index_dual_compute (tenant_id, user_id, date, scope) values (t_t(), t_u(), current_date, 'nope');
    raise exception 'FAIL: unknown scope accepted';
  exception when check_violation then null; end;
  begin
    insert into public.vitana_index_dual_compute (tenant_id, user_id, date, scope, diff_class) values (t_t(), t_u(), current_date, 'all', '{made_up}');
    raise exception 'FAIL: unknown diff_class accepted';
  exception when check_violation then null; end;
  begin
    insert into public.vitana_index_dual_compute (tenant_id, user_id, date, scope, device_rows_missing) values (t_t(), t_u(), current_date, 'all', -1);
    raise exception 'FAIL: negative row count accepted';
  exception when check_violation then null; end;
  insert into public.vitana_index_dual_compute (tenant_id, user_id, date, scope, failure_code) values (t_t(), t_u(), current_date, 'all', 'PROJECTION_FAILED');
end $$;
\echo 'PASS vtid-05163 dual-compute table'

-- ── 5. erase_user_data() finds all five of B's tables by its catalogue scan. ─
do $$
declare j jsonb; t text; v_n int; other uuid := 'b0000000-0000-0000-0000-00000000000b';
begin
  insert into auth.users (id) values (t_u()), (other) on conflict do nothing;
  insert into public.health_sources (tenant_id, user_id, kind, status) values (t_t(), t_u(), 'diary', 'connected'), (t_t(), other, 'diary', 'connected');
  insert into public.health_features_daily_legacy_shadow (tenant_id, user_id, date, feature_key, feature_value) values
    (t_t(), t_u(), current_date, 'meal_log', 1), (t_t(), other, current_date, 'meal_log', 1);
  insert into public.health_features_derivation_pending (tenant_id, user_id, date) values (t_t(), t_u(), current_date), (t_t(), other, current_date);
  delete from public.health_features_daily_v2;
  insert into public.health_features_daily_v2 (tenant_id, user_id, date, feature_key, feature_value, derivation_version) values
    (t_t(), t_u(), current_date, 'meal_log', 1, 'b2.1'), (t_t(), other, current_date, 'meal_log', 1, 'b2.1');
  insert into public.vitana_index_dual_compute (tenant_id, user_id, date, scope) values (t_t(), other, current_date, 'device');

  j := public.erase_user_data(t_u(), true);
  foreach t in array array['health_sources', 'health_features_daily_v2', 'health_features_daily_legacy_shadow',
                           'health_features_derivation_pending', 'vitana_index_dual_compute'] loop
    if coalesce((j -> 'deleted' ->> t)::int, 0) < 1 then raise exception 'FAIL: dry run does not count %: %', t, j; end if;
  end loop;
  if (j -> 'deleted' ->> 'vitana_index_dual_compute')::int <> 2 then raise exception 'FAIL: dry run dual-compute count: %', j; end if;
  if (select count(*) from public.vitana_index_dual_compute) <> 3 then raise exception 'FAIL: the dry run deleted rows'; end if;

  perform public.erase_user_data(t_u(), false);
  foreach t in array array['health_sources', 'health_features_daily_v2', 'health_features_daily_legacy_shadow',
                           'health_features_derivation_pending', 'vitana_index_dual_compute'] loop
    execute format('select count(*) from public.%I where user_id = $1', t) into v_n using t_u();
    if v_n <> 0 then raise exception 'FAIL: % rows left in % for the erased member', v_n, t; end if;
    execute format('select count(*) from public.%I where user_id = $1', t) into v_n using other;
    if v_n <> 1 then raise exception 'FAIL: erasure touched another member in %', t; end if;
  end loop;
end $$;
\echo 'PASS vtid-05163 erasure discovery'

\echo 'PASS vtid-05163 index dual compute'
