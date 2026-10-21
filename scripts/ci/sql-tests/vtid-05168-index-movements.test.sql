-- VTID-05168: Vitana Index movements against a synthetic schema on a throwaway
-- local Postgres. Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-index-movements-test.sh
-- The real scoring body is replaced by a small stand-in with the SAME signature
-- and the same upsert target; the migration renames whatever body exists and
-- never reads it, so the wrapper logic is what is tested here.
\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  if not exists (select 1 from pg_roles where rolname = 'migrate') then create role migrate; end if;
end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create table public.user_tenants (user_id uuid, tenant_id uuid);
create table public.vitana_index_config (pillar_weights jsonb, is_active boolean, version int);
insert into public.vitana_index_config values ('{"nutrition":1,"hydration":1,"exercise":1,"sleep":1,"mental":1}', true, 1);
create table public.vitana_index_scores (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, user_id uuid not null, date date not null,
  score_total int, score_nutrition int, score_hydration int, score_exercise int, score_sleep int, score_mental int,
  model_version text, feature_inputs jsonb, confidence numeric, updated_at timestamptz default now(),
  unique (tenant_id, user_id, date)
);
create table public.calendar_events (id uuid primary key default gen_random_uuid(), user_id uuid, completion_status text);
-- Stand-in inputs: points per pillar for a member.
create table public.t_points (user_id uuid primary key, n int, h int, e int, s int, m int);

-- Stand-in for the live canonical function (same name, args, return type, upsert).
create function public.health_compute_vitana_index_for_user(p_user_id uuid, p_date date, p_model_version text default 'v3-5pillar')
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.t_points; v_t uuid; tot int; bf numeric;
begin
  select * into p from public.t_points where user_id = p_user_id;
  select tenant_id into v_t from public.user_tenants where user_id = p_user_id limit 1;
  v_t := coalesce(v_t, '00000000-0000-0000-0000-000000000000');
  bf := case when least(p.n,p.h,p.e,p.s,p.m)::numeric / greatest(p.n,p.h,p.e,p.s,p.m) >= 0.7 then 1.0 else 0.9 end;
  tot := round((p.n + p.h + p.e + p.s + p.m) * bf);
  insert into public.vitana_index_scores (tenant_id, user_id, date, score_total, score_nutrition, score_hydration,
    score_exercise, score_sleep, score_mental, model_version, feature_inputs, confidence)
  values (v_t, p_user_id, p_date, tot, p.n, p.h, p.e, p.s, p.m, p_model_version,
    jsonb_build_object('balance_factor', bf, 'raw_sum', p.n + p.h + p.e + p.s + p.m, 'ratio', 0.5), 0.7)
  on conflict (tenant_id, user_id, date) do update set score_total = excluded.score_total,
    score_nutrition = excluded.score_nutrition, score_hydration = excluded.score_hydration,
    score_exercise = excluded.score_exercise, score_sleep = excluded.score_sleep, score_mental = excluded.score_mental,
    feature_inputs = excluded.feature_inputs, updated_at = now();
  return jsonb_build_object('ok', true, 'date', p_date, 'user_id', p_user_id, 'score_total', tot,
    'score_nutrition', p.n, 'score_hydration', p.h, 'score_exercise', p.e, 'score_sleep', p.s, 'score_mental', p.m,
    'balance_factor', bf, 'confidence', 0.7, 'model_version', p_model_version);
end $$;
grant execute on function public.health_compute_vitana_index_for_user(uuid, date, text) to service_role, migrate;

-- Stand-ins for the objects the migration replaces (signatures as live).
create function public.scheduler_vitana_index_compute_daily(p_user_id uuid, p_date date) returns jsonb
  language sql security definer as $$ select public.health_compute_vitana_index_for_user(p_user_id, p_date, 'v3-5pillar') $$;
create function public.vitana_trg_calendar_completion_recompute() returns trigger language plpgsql security definer as
  $$ begin perform public.health_compute_vitana_index_for_user(new.user_id, current_date, 'v3-5pillar'); return new; end $$;
create trigger trg_calendar_completion_recompute after update of completion_status on public.calendar_events
  for each row execute function public.vitana_trg_calendar_completion_recompute();
create function public.health_compute_vitana_index(p_date date, p_model_version text default 'v3-5pillar') returns jsonb
  language sql security definer as $$ select '{"ok":true,"legacy":true}'::jsonb $$;
create function public.health_compute_vitana_index(p_date date default current_date)
  returns table(user_id uuid, score_total integer, score_nutrition integer, score_hydration integer, score_exercise integer,
                score_sleep integer, score_mental integer, confidence numeric, model_version text, feature_inputs jsonb)
  language sql security definer as $$ select null::uuid, 0, 0, 0, 0, 0, 0, 0::numeric, 'legacy', '{}'::jsonb $$;
grant execute on function public.health_compute_vitana_index(date, text) to authenticated;
grant execute on function public.health_compute_vitana_index(date) to authenticated;

\ir ../../../supabase/migrations/20261014140000_vtid_05168_index_movements.sql
\ir ../../../supabase/migrations/20261014140000_vtid_05168_index_movements.sql

\set u1 '''11111111-1111-1111-1111-111111111111'''
insert into public.t_points values (:u1, 40, 40, 40, 40, 40);

do $$
declare
  u uuid := '11111111-1111-1111-1111-111111111111';
  r jsonb; m record; n int; ev uuid;
begin
  -- 1. First score ever → a movement with no "before".
  r := public.vitana_index_recompute_and_record(u, current_date, 'manual_log', 'health_feature', 'water_intake');
  if not (r->>'ok')::boolean then raise exception 'first call failed: %', r; end if;
  select * into m from public.vitana_index_movements where user_id = u;
  if m.before is not null or m.delta_total <> 200 or m.trigger <> 'manual_log' or m.source_ref <> 'water_intake'
    then raise exception 'first movement wrong: %', row_to_json(m); end if;
  if (r->>'movement_id')::uuid <> m.id then raise exception 'result must carry movement_id'; end if;

  -- 2. Nothing changed → no movement, delta 0.
  r := public.vitana_index_recompute_and_record(u, current_date, 'voice_log');
  select count(*) into n from public.vitana_index_movements where user_id = u;
  if n <> 1 or (r->>'delta_total')::int <> 0 or r ? 'movement_id' and r->>'movement_id' is not null
    then raise exception 'unchanged recompute must not record (n=%, r=%)', n, r; end if;

  -- 3. A change → movement with per-pillar delta and balance before/after.
  update public.t_points set h = 52 where user_id = u;
  r := public.vitana_index_recompute_and_record(u, current_date, 'voice_log', 'health_feature', 'water_intake');
  select * into m from public.vitana_index_movements where user_id = u and trigger = 'voice_log';
  if m.delta_total <> 12 or (m.delta_pillars->>'hydration')::int <> 12 or (m.delta_pillars->>'sleep')::int <> 0
     or (m.before->>'hydration')::int <> 40 or m.balance_after is null
    then raise exception 'change movement wrong: %', row_to_json(m); end if;
  if (r->'per_pillar_delta'->>'hydration')::int <> 12 or (r->>'prior_score_total')::int <> 200
    then raise exception 'result deltas wrong: %', r; end if;

  -- 4. First recompute of a new day compares with the latest earlier day.
  update public.t_points set e = 70 where user_id = u;
  r := public.vitana_index_recompute_and_record(u, current_date + 1, 'daily', 'scheduler');
  select * into m from public.vitana_index_movements where user_id = u and score_date = current_date + 1;
  if (m.before->>'exercise')::int <> 40 or (m.delta_pillars->>'exercise')::int <> 30 or (m.before->>'date')::date <> current_date
    then raise exception 'day rollover wrong: %', row_to_json(m); end if;

  -- 5. Old name = wrapper, recorded as 'unspecified'.
  update public.t_points set s = 50 where user_id = u;
  r := public.health_compute_vitana_index_for_user(u, current_date + 1, 'v3-5pillar');
  if not exists (select 1 from public.vitana_index_movements where user_id = u and trigger = 'unspecified')
    then raise exception 'old-name wrapper must record'; end if;

  -- 6. Scheduler → 'daily'.
  update public.t_points set n = 45 where user_id = u;
  r := public.scheduler_vitana_index_compute_daily(u, current_date + 1);
  if not (r->>'ok')::boolean or r->>'stage' <> 'index' then raise exception 'scheduler shape: %', r; end if;
  if (select count(*) from public.vitana_index_movements where user_id = u and trigger = 'daily') <> 2
    then raise exception 'scheduler must record trigger daily'; end if;

  -- 7. Calendar completion trigger → 'calendar_completion' with the event id.
  insert into public.calendar_events (user_id, completion_status) values (u, 'planned') returning id into ev;
  update public.t_points set m = 58 where user_id = u;
  update public.calendar_events set completion_status = 'completed' where id = ev;
  if not exists (select 1 from public.vitana_index_movements
                  where user_id = u and trigger = 'calendar_completion' and source_kind = 'calendar_event' and source_ref = ev::text)
    then raise exception 'calendar trigger must record with the event id'; end if;

  -- 8. Invalid trigger refused.
  r := public.vitana_index_recompute_and_record(u, current_date, 'Bad Trigger!');
  if r->>'error' <> 'INVALID_TRIGGER' then raise exception 'invalid trigger accepted'; end if;
end $$;

-- 9. Member-callable overloads: auth.uid(), canonical scoring, original shapes.
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
declare r jsonb;
begin
  update public.t_points set n = 47 where user_id = '11111111-1111-1111-1111-111111111111';
  r := public.health_compute_vitana_index(current_date + 1, 'v3-5pillar');
  if not (r->>'ok')::boolean or r ? 'legacy' or not (r ? 'pillar_weights') or not (r ? 'raw_sum') or r ? 'movement_id'
    then raise exception '(date,text) overload shape: %', r; end if;
  if not exists (select 1 from public.vitana_index_movements where trigger = 'self_heal')
    then raise exception 'overload must record self_heal'; end if;
  -- The one-argument overload is ambiguous with (date, text DEFAULT …) and cannot be
  -- called with one positional/named argument — true in production already. Pin its
  -- body instead: it must go through the recording function, never score itself.
  if pg_get_functiondef('public.health_compute_vitana_index(date)'::regprocedure) not like '%vitana_index_recompute_and_record%'
    then raise exception '(date) overload must route through the recording function'; end if;
end $$;
reset request.jwt.claim.sub;
do $$ begin
  if public.health_compute_vitana_index(current_date, 'v3-5pillar')->>'error' <> 'NOT_AUTHENTICATED'
    then raise exception 'overload without a user must refuse'; end if;
end $$;

-- 10. Privileges.
do $$ begin
  if has_function_privilege('authenticated', 'public.vitana_index_recompute_and_record(uuid,date,text,text,text,text)', 'execute')
    then raise exception 'authenticated can run the recording function'; end if;
  if has_function_privilege('authenticated', 'public.health_compute_vitana_index_core(uuid,date,text)', 'execute')
    then raise exception 'authenticated can run the core'; end if;
  if has_function_privilege('migrate', 'public.health_compute_vitana_index_core(uuid,date,text)', 'execute')
    then raise exception 'migrate can run the core'; end if;
  if has_function_privilege('authenticated', 'public.health_compute_vitana_index_for_user(uuid,date,text)', 'execute')
    then raise exception 'authenticated can run for_user'; end if;
  if has_function_privilege('anon', 'public.health_compute_vitana_index(date,text)', 'execute')
    then raise exception 'anon can run the overload'; end if;
  if not has_function_privilege('authenticated', 'public.health_compute_vitana_index(date,text)', 'execute')
    or not has_function_privilege('authenticated', 'public.health_compute_vitana_index(date)', 'execute')
    then raise exception 'members lost the overload grants'; end if;
  if not has_function_privilege('service_role', 'public.vitana_index_recompute_and_record(uuid,date,text,text,text,text)', 'execute')
    then raise exception 'service_role cannot record'; end if;
  if has_table_privilege('authenticated', 'public.vitana_index_movements', 'insert')
    then raise exception 'members can write movements'; end if;
  if pg_get_function_arguments('public.health_compute_vitana_index(date)'::regprocedure) <> 'p_date date DEFAULT CURRENT_DATE'
    then raise exception 'the live default of health_compute_vitana_index(date) was dropped'; end if;
end $$;

-- Concurrency fixture for the runner (second phase).
insert into public.t_points values ('22222222-2222-2222-2222-222222222222', 40, 40, 40, 40, 40);
select public.vitana_index_recompute_and_record('22222222-2222-2222-2222-222222222222', current_date, 'manual_log') is not null;

\echo 'PASS vtid-05168 index movements (sequential)'
