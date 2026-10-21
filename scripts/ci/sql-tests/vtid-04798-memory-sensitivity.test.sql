-- VTID-04798: memory sensitivity (GDPR Art. 9) against a synthetic schema on
-- a throwaway local Postgres. Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-memory-sensitivity-test.sh
\set ON_ERROR_STOP on

-- The two memory tables as far as the migration touches them, with rows that
-- exist before it runs (the backfill).
create table public.memory_facts (
  id serial primary key,
  fact_key text not null,
  fact_value text not null default 'v',
  superseded_by int
);
create table public.memory_items (
  id serial primary key,
  category_key text not null,
  content text not null default 'c'
);
insert into public.memory_facts (fact_key) values
  ('user_health_condition'), ('user_medication'), ('daughter_health_condition'),
  ('user_sleep_duration'), ('user_weakest_pillar'), ('user_steps_today'),
  ('user_diet'), ('user_observation_mood'), ('user_alcohol_consumption'),
  ('spouse_name'), ('user_hobby_dancing'), ('user_hobby_painting'),
  ('user_favorite_food_spicy'), ('upcoming_event_flight_abu_dhabi'), ('user_pet_name');
insert into public.memory_items (category_key) values
  ('health'), ('health_wellness'), ('conversation'), ('relationships'), ('goals');

\ir ../../../supabase/migrations/20261001160000_vtid_04798_memory_sensitivity.sql

do $$
declare
  v_wrong text;
begin
  -- 1. Backfill: Art. 9 keys are special_category, the rest standard.
  select string_agg(fact_key || '=' || sensitivity, ', ') into v_wrong
    from public.memory_facts
   where (fact_key in ('user_health_condition','user_medication','daughter_health_condition',
                       'user_sleep_duration','user_weakest_pillar','user_steps_today','user_diet',
                       'user_observation_mood','user_alcohol_consumption')
          and sensitivity <> 'special_category')
      or (fact_key in ('spouse_name','user_hobby_dancing','user_hobby_painting',
                       'user_favorite_food_spicy','upcoming_event_flight_abu_dhabi','user_pet_name')
          and sensitivity <> 'standard');
  if v_wrong is not null then raise exception 'backfill wrong for facts: %', v_wrong; end if;

  select string_agg(category_key || '=' || sensitivity, ', ') into v_wrong
    from public.memory_items
   where (category_key in ('health','health_wellness') and sensitivity <> 'special_category')
      or (category_key in ('conversation','relationships','goals') and sensitivity <> 'standard');
  if v_wrong is not null then raise exception 'backfill wrong for items: %', v_wrong; end if;

  -- 2. New rows: the trigger classifies every insert, whatever the writer sends.
  insert into public.memory_facts (fact_key) values ('user_blood_pressure'), ('user_favorite_tv_show');
  insert into public.memory_facts (fact_key, sensitivity) values ('user_religion', 'standard');
  if (select sensitivity from public.memory_facts where fact_key = 'user_blood_pressure') <> 'special_category'
    then raise exception 'insert: blood pressure not special_category'; end if;
  if (select sensitivity from public.memory_facts where fact_key = 'user_favorite_tv_show') <> 'standard'
    then raise exception 'insert: tv show not standard'; end if;
  if (select sensitivity from public.memory_facts where fact_key = 'user_religion') <> 'special_category'
    then raise exception 'insert: a writer sending standard must not lower religion'; end if;
  insert into public.memory_items (category_key) values ('health');
  if (select sensitivity from public.memory_items order by id desc limit 1) <> 'special_category'
    then raise exception 'insert: health item not special_category'; end if;

  -- 3. A writer may mark a row special_category itself; it is never lowered.
  insert into public.memory_facts (fact_key, sensitivity) values ('user_note', 'special_category');
  update public.memory_facts set fact_key = 'user_note_renamed' where fact_key = 'user_note';
  if (select sensitivity from public.memory_facts where fact_key = 'user_note_renamed') <> 'special_category'
    then raise exception 'update: explicit special_category was lowered'; end if;

  -- 4. Renaming a key to an Art. 9 key raises it.
  update public.memory_facts set fact_key = 'user_health_note' where fact_key = 'user_favorite_tv_show';
  if (select sensitivity from public.memory_facts where fact_key = 'user_health_note') <> 'special_category'
    then raise exception 'update: rename to a health key not raised'; end if;

  -- 5. Only the two values are allowed.
  begin
    insert into public.memory_items (category_key, sensitivity) values ('goals', 'secret');
    raise exception 'check constraint missing';
  exception when check_violation then null;
  end;

  -- 6. Token rules: short words match whole tokens only.
  if public.memory_sensitivity_of('user_back_pain') <> 'special_category' then raise exception 'pain'; end if;
  if public.memory_sensitivity_of('user_hobby_painting') <> 'standard' then raise exception 'painting'; end if;
  if public.memory_sensitivity_of('user_label_maker') <> 'standard' then raise exception 'label'; end if;
  if public.memory_sensitivity_of(null) <> 'standard' then raise exception 'null'; end if;

  -- 7. The migration runs twice without error (idempotent).
end $$;

\ir ../../../supabase/migrations/20261001160000_vtid_04798_memory_sensitivity.sql

\echo PASS vtid-04798 memory sensitivity
