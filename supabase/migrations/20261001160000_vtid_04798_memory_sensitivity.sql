-- VTID-04798 — memory plan phase 3 (docs/MEMORY-SYSTEM-PLAN.md §8.2, §8.4):
-- sensitivity on every memory row.
--
-- GDPR Art. 9 data (health, religion, sexual orientation, ethnic origin,
-- political opinion, genetic and biometric data) sat in memory_facts and
-- memory_items with nothing marking it. Measured 2026-10-01: ~45 current
-- fact keys (user_health_condition, user_medication, user_sleep_duration,
-- daughter_health_condition, ...) and ~65 memory_items in the health
-- categories, all unmarked. The community member ranker matched every
-- member's facts by keyword and showed the matched fact to another member as
-- the reason for a suggestion, health facts included.
--
-- sensitivity: 'standard' | 'special_category'.
--   * One rule decides it: memory_sensitivity_of(text) on the fact key
--     (memory_facts) or the category key (memory_items). It is in the
--     database so every writer gets it, whichever path it takes.
--   * A BEFORE INSERT / UPDATE trigger sets it. It never lowers a row the
--     writer marked special_category itself.
--   * Existing rows are backfilled here.
--   * The rule errs towards special_category: a false positive only keeps a
--     row away from other members; a false negative exposes it. Diet,
--     intake, steps and the Vitana Index count as health data here (this is
--     a health app). Hobbies and activities (dancing, tennis) stay standard:
--     the member ranker matches on them.
--
-- Readers: special_category rows reach the member's own surfaces and the
-- Health Coach only (plan §8.2). The gateway applies this where a row can
-- reach someone else (the member ranker, VTID-04798). Row-level enforcement
-- (RLS + a non-bypass role) is phase 3b.
--
-- Role scope: memory_items already carries active_role (VTID-04367,
-- NULL = personal). memory_facts stays personal-only; a work-surface
-- conversation no longer writes it (gateway, VTID-04798). A role column on
-- memory_facts comes with the RLS work in phase 3b, when every reader is
-- covered by the database, not by each of its ~80 call sites.
--
-- memory_items.sensitivity_flag (VTID-01116, medical/psychological/...) was
-- never written (0 of 3,737 rows) and is left as is.

create or replace function public.memory_sensitivity_of(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case
    when p_text is null then 'standard'
    when lower(p_text) ~ (
      -- stems matched anywhere in the key
      '(health|medic|diagnos|allerg|symptom|diabet|cholesterol|pregnan|depress|anxiet|therap|surgery|surgical|injur|disease|illness|biomarker|glucose|supplement|vitamin|sleep|weight|blood|mental|psych|disabilit|addict|religio|sexual|ethnic|politic|genetic|biometric|vitana_index|alcohol|immun|mobility|mood|diet|nutrition|calori|fasting|smok|water_intake|water_consumption|step_count|weak_area|weakest_area|low_area)'
      -- short words matched as whole key tokens only ("pain" not "painting")
      || '|(^|_)(pain|lab|labs|bmi|hrv|heart|drug|drugs|pill|pills|pillar|faith|hydration|nap|fat|index|steps)(_|$)'
    ) then 'special_category'
    else 'standard'
  end
$$;

comment on function public.memory_sensitivity_of(text) is
  'VTID-04798: special_category (GDPR Art. 9) or standard, from a memory fact key or category key.';

alter table public.memory_facts
  add column if not exists sensitivity text not null default 'standard';
alter table public.memory_items
  add column if not exists sensitivity text not null default 'standard';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'memory_facts_sensitivity_check') then
    alter table public.memory_facts
      add constraint memory_facts_sensitivity_check check (sensitivity in ('standard', 'special_category'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'memory_items_sensitivity_check') then
    alter table public.memory_items
      add constraint memory_items_sensitivity_check check (sensitivity in ('standard', 'special_category'));
  end if;
end $$;

create or replace function public.memory_facts_set_sensitivity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.sensitivity is distinct from 'special_category'
     and public.memory_sensitivity_of(new.fact_key) = 'special_category' then
    new.sensitivity := 'special_category';
  end if;
  return new;
end;
$$;

create or replace function public.memory_items_set_sensitivity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.sensitivity is distinct from 'special_category'
     and public.memory_sensitivity_of(new.category_key) = 'special_category' then
    new.sensitivity := 'special_category';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_memory_facts_sensitivity on public.memory_facts;
create trigger trg_memory_facts_sensitivity
  before insert or update of fact_key, sensitivity on public.memory_facts
  for each row execute function public.memory_facts_set_sensitivity();

drop trigger if exists trg_memory_items_sensitivity on public.memory_items;
create trigger trg_memory_items_sensitivity
  before insert or update of category_key, sensitivity on public.memory_items
  for each row execute function public.memory_items_set_sensitivity();

-- Backfill. Only sensitivity changes, so the Identity Lock trigger
-- (UPDATE OF fact_key, fact_value, provenance_source) does not fire, and the
-- memory_items confidence log only writes when confidence_score changes.
update public.memory_facts
   set sensitivity = 'special_category'
 where sensitivity <> 'special_category'
   and public.memory_sensitivity_of(fact_key) = 'special_category';

update public.memory_items
   set sensitivity = 'special_category'
 where sensitivity <> 'special_category'
   and public.memory_sensitivity_of(category_key) = 'special_category';
