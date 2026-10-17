-- VTID-05092: health consent categories migration on a throwaway local Postgres.
-- Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-health-consent-test.sh
\set ON_ERROR_STOP on

-- The Supabase roles the migration grants to / revokes from.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

-- Stand-ins exactly as VTID-03885 created them (only the tables this
-- migration touches or reads), with Supabase's default table grants
-- (ALL to anon/authenticated/service_role) so the revokes are meaningful.
create table public.partner_registry (
  id uuid primary key default gen_random_uuid(),
  partner_key text not null unique,
  display_name text not null,
  integration_mode text not null default 'portal_manual' check (integration_mode in ('portal_manual', 'webhook', 'api_sync')),
  status text not null default 'sandbox' check (status in ('active', 'sandbox', 'disabled'))
);
create table public.partner_health_test_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  partner_id uuid not null references public.partner_registry(id) on delete cascade,
  test_name text not null
);
create table public.partner_health_result_inbox (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partner_registry(id) on delete cascade,
  raw_payload jsonb not null default '{}'::jsonb,
  reason text not null check (reason in ('no_match', 'ambiguous_match', 'invalid_payload', 'consent_missing')),
  resolved boolean not null default false
);
create table public.data_sharing_consents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  resource_type text not null,
  resource_id text not null,
  scope text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  granted_via text not null check (granted_via in ('checkout_flow', 'settings_connected_apps', 'portal_admin_backfill')),
  created_at timestamptz not null default now()
);
create unique index data_sharing_consents_uidx on public.data_sharing_consents (tenant_id, user_id, resource_type, resource_id, scope);
create table public.data_sharing_consent_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  resource_type text not null,
  resource_id text not null,
  scope text not null,
  action text not null check (action in ('grant', 'revoke')),
  actor_role text,
  actor_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
alter table public.data_sharing_consents enable row level security;
alter table public.data_sharing_consent_events enable row level security;
grant all on public.partner_registry, public.partner_health_test_orders, public.partner_health_result_inbox,
  public.data_sharing_consents, public.data_sharing_consent_events to anon, authenticated, service_role;

insert into public.partner_registry (partner_key, display_name, status) values
  ('doctorbox', 'DoctorBox', 'sandbox'),
  ('activelab', 'ActiveLab', 'active'),
  ('gonelab', 'GoneLab', 'disabled');

-- A legacy DoctorBox grant from before VTID-05092 (no wording recorded).
insert into public.data_sharing_consents (tenant_id, user_id, resource_type, resource_id, scope, granted_via)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
          'partner_integration', 'doctorbox', 'result_ingestion', 'settings_connected_apps');

-- Applied twice: idempotent.
\ir ../../../supabase/migrations/20261012180000_vtid_05092_health_consent_categories.sql
\ir ../../../supabase/migrations/20261012180000_vtid_05092_health_consent_categories.sql

-- Helper: true when the statement raises (any error).
create function pg_temp.rejected(sql text) returns boolean language plpgsql as $$
begin
  execute sql;
  return false;
exception when others then
  return true;
end $$;

create function pg_temp.events(u uuid) returns bigint language sql as $$
  select count(*) from public.data_sharing_consent_events where user_id = u
$$;

do $$
declare
  t uuid := '00000000-0000-0000-0000-0000000000a1';
  legacy_user uuid := '00000000-0000-0000-0000-0000000000b1';
  u uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  r jsonb;
  c record;
begin
  -- Catalogue: the five seeds, no default-on column, legacy row untouched.
  assert (select array_agg(key order by sort) from public.health_consent_categories)
       = array['wearables', 'partner_results', 'ai_health_analysis', 'health_data_analytics', 'community_insights'], 'five seeds in order';
  assert (select count(*) from public.health_consent_categories where current_text_version = 'v1') = 5, 'all at v1';
  assert (select processing_active from public.health_consent_categories where key = 'partner_results'), 'partner_results is enforced (ingestion)';
  assert (select count(*) from public.health_consent_categories where processing_active and key <> 'partner_results') = 0, 'no other category is processing_active';
  assert (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name in ('health_consent_categories', 'data_sharing_consents', 'data_sharing_consent_events')
             and (column_name ~ 'default_on|granted_by_default|default_granted')) = 0, 'no default-on column';
  assert (select text_version is null and category_key is null and revoked_at is null from public.data_sharing_consents where user_id = legacy_user), 'legacy row kept as-is';

  -- A bumped version is not reset by re-applying the seed.
  update public.health_consent_categories set current_text_version = 'v2' where key = 'community_insights';
  insert into public.health_consent_categories (key, resource_type, scope, per_resource, current_text_version, processing_active, sort)
    values ('community_insights', 'health_category', 'processing', false, 'v1', false, 50) on conflict (key) do nothing;
  assert (select current_text_version from public.health_consent_categories where key = 'community_insights') = 'v2', 'seed never resets a version';

  -- granted_via: new values accepted, unknown rejected.
  assert pg_temp.rejected(format($q$insert into public.data_sharing_consents (tenant_id, user_id, resource_type, resource_id, scope, granted_via) values (%L, %L, 'x', 'y', 'z', 'bogus')$q$, t, u)), 'unknown granted_via rejected';
  assert (select count(*) from pg_constraint where conrelid = 'public.data_sharing_consents'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%granted_via%') = 1, 'exactly one granted_via check';

  -- Privileges.
  for c in select * from (values ('public.data_sharing_consents'), ('public.data_sharing_consent_events')) v(tbl) loop
    assert not has_table_privilege('anon', c.tbl, 'insert'), c.tbl || ': anon insert revoked';
    assert not has_table_privilege('anon', c.tbl, 'update'), c.tbl || ': anon update revoked';
    assert not has_table_privilege('anon', c.tbl, 'delete'), c.tbl || ': anon delete revoked';
    assert not has_table_privilege('authenticated', c.tbl, 'insert'), c.tbl || ': authenticated insert revoked';
    assert not has_table_privilege('authenticated', c.tbl, 'update'), c.tbl || ': authenticated update revoked';
    assert not has_table_privilege('authenticated', c.tbl, 'delete'), c.tbl || ': authenticated delete revoked';
    assert not has_table_privilege('authenticated', c.tbl, 'truncate'), c.tbl || ': authenticated truncate revoked';
    assert has_table_privilege('authenticated', c.tbl, 'select'), c.tbl || ': authenticated still reads (RLS scopes rows)';
  end loop;
  assert not has_table_privilege('service_role', 'public.data_sharing_consent_events', 'update'), 'service_role cannot update events';
  assert not has_table_privilege('service_role', 'public.data_sharing_consent_events', 'delete'), 'service_role cannot delete events';
  assert not has_table_privilege('service_role', 'public.data_sharing_consent_events', 'truncate'), 'service_role cannot truncate events';
  assert has_table_privilege('authenticated', 'public.health_consent_categories', 'select'), 'members read the catalogue';
  assert not has_table_privilege('authenticated', 'public.health_consent_categories', 'insert'), 'members do not write the catalogue';
  assert not has_table_privilege('anon', 'public.health_consent_categories', 'select'), 'anon does not read the catalogue';
  assert has_function_privilege('service_role', 'public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text)', 'execute'), 'service_role executes';
  assert not has_function_privilege('authenticated', 'public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text)', 'execute'), 'authenticated cannot execute';
  assert not has_function_privilege('anon', 'public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text)', 'execute'), 'anon cannot execute';
  assert (select prosecdef from pg_proc where proname = 'fn_set_health_consent'), 'security definer';
  assert (select relrowsecurity from pg_class where oid = 'public.health_consent_categories'::regclass), 'catalogue has RLS';

  -- Validation codes; nothing written on any of them.
  r := public.fn_set_health_consent(t, u, 'nope', null, 'grant', 'settings_privacy', 'v1', 'de', 'user', u, 'req-0');
  assert r ->> 'code' = 'unknown_category', 'unknown category';
  r := public.fn_set_health_consent(t, u, 'ai_health_analysis', null, 'delete', 'settings_privacy', 'v1', 'de', 'user', u, 'req-0');
  assert r ->> 'code' = 'invalid_action', 'invalid action';
  r := public.fn_set_health_consent(t, u, 'ai_health_analysis', null, 'grant', 'settings_privacy', 'v0', 'de', 'user', u, 'req-0');
  assert r ->> 'code' = 'stale_text_version', 'stale version';
  r := public.fn_set_health_consent(t, u, 'ai_health_analysis', null, 'grant', 'settings_privacy', null, 'de', 'user', u, 'req-0');
  assert r ->> 'code' = 'stale_text_version', 'missing version';
  r := public.fn_set_health_consent(t, u, 'ai_health_analysis', null, 'grant', 'settings_privacy', 'legacy-03885', 'de', 'user', u, 'req-0');
  assert r ->> 'code' = 'stale_text_version', 'legacy version only for partner_results';
  r := public.fn_set_health_consent(t, u, 'ai_health_analysis', null, 'grant', 'bogus', 'v1', 'de', 'user', u, 'req-0');
  assert r ->> 'code' = 'invalid_granted_via', 'invalid granted_via';
  r := public.fn_set_health_consent(t, u, 'ai_health_analysis', 'doctorbox', 'grant', 'settings_privacy', 'v1', 'de', 'user', u, 'req-0');
  assert r ->> 'code' = 'unknown_resource', 'a category-wide consent takes no other resource';
  r := public.fn_set_health_consent(t, u, 'partner_results', null, 'grant', 'settings_privacy', 'v1', 'de', 'user', u, 'req-0');
  assert r ->> 'code' = 'resource_required', 'per-partner consent needs a partner';
  r := public.fn_set_health_consent(t, u, 'partner_results', 'nolab', 'grant', 'settings_privacy', 'v1', 'de', 'user', u, 'req-0');
  assert r ->> 'code' = 'unknown_resource', 'unknown partner';
  r := public.fn_set_health_consent(t, u, 'partner_results', 'gonelab', 'grant', 'settings_privacy', 'v1', 'de', 'user', u, 'req-0');
  assert r ->> 'code' = 'unknown_resource', 'disabled partner';
  r := public.fn_set_health_consent(t, u, 'wearables', '  ', 'grant', 'settings_privacy', 'v1', 'de', 'user', u, 'req-0');
  assert r ->> 'code' = 'resource_required', 'blank connector';
  assert (select count(*) from public.data_sharing_consents where user_id = u) = 0 and pg_temp.events(u) = 0, 'nothing written on a validation failure';
  assert pg_temp.rejected(format($q$select public.fn_set_health_consent(null, %L, 'ai_health_analysis', null, 'grant', 'settings_privacy', 'v1', 'de', 'user', null, null)$q$, u)), 'tenant required';

  -- Grant: consent + one event, in one call.
  r := public.fn_set_health_consent(t, u, 'ai_health_analysis', null, 'grant', 'settings_privacy', 'v1', 'de', 'user', u, 'req-1');
  assert (r ->> 'ok')::boolean and (r ->> 'changed')::boolean, 'granted';
  assert r ->> 'resource_id' = 'ai_health_analysis' and r ->> 'resource_type' = 'health_category' and r ->> 'scope' = 'processing', 'category-wide consent stored under its own key';
  assert (select category_key || '/' || text_version || '/' || shown_locale || '/' || granted_via from public.data_sharing_consents where user_id = u) = 'ai_health_analysis/v1/de/settings_privacy', 'row records category, version, locale, source';
  assert pg_temp.events(u) = 1, 'one event';
  assert (select action || '/' || category_key || '/' || text_version || '/' || shown_locale || '/' || request_id || '/' || (before is null)::text
            from public.data_sharing_consent_events where user_id = u) = 'grant/ai_health_analysis/v1/de/req-1/true', 'event records the grant';
  assert (select id from public.data_sharing_consent_events where user_id = u) = (r ->> 'event_id')::uuid, 'event id returned';

  -- Idempotent: same version + locale -> no event.
  r := public.fn_set_health_consent(t, u, 'ai_health_analysis', null, 'grant', 'settings_privacy', 'v1', 'de', 'user', u, 'req-2');
  assert (r ->> 'ok')::boolean and not (r ->> 'changed')::boolean and pg_temp.events(u) = 1, 'same grant is a no-op';
  -- Different locale -> re-recorded.
  r := public.fn_set_health_consent(t, u, 'ai_health_analysis', null, 'grant', 'settings_privacy', 'v1', 'en', 'user', u, 'req-3');
  assert (r ->> 'changed')::boolean and pg_temp.events(u) = 2, 'new locale re-recorded';
  assert (select before ->> 'shown_locale' from public.data_sharing_consent_events where request_id = 'req-3') = 'de', 'before snapshot kept';

  -- Revoke: one event; revoking again is a no-op.
  r := public.fn_set_health_consent(t, u, 'ai_health_analysis', null, 'revoke', null, null, null, 'user', u, 'req-4');
  assert (r ->> 'changed')::boolean and r ->> 'revoked_at' is not null and pg_temp.events(u) = 3, 'revoked';
  r := public.fn_set_health_consent(t, u, 'ai_health_analysis', null, 'revoke', null, null, null, 'user', u, 'req-5');
  assert not (r ->> 'changed')::boolean and pg_temp.events(u) = 3, 'second revoke is a no-op';
  r := public.fn_set_health_consent(t, u, 'community_insights', null, 'revoke', null, null, null, 'user', u, 'req-6');
  assert (r ->> 'ok')::boolean and not (r ->> 'changed')::boolean and pg_temp.events(u) = 3, 'revoking a never-granted consent is a no-op';
  -- Re-grant after revoke reactivates the same row.
  r := public.fn_set_health_consent(t, u, 'ai_health_analysis', null, 'grant', 'settings_privacy', 'v1', 'en', 'user', u, 'req-7');
  assert (r ->> 'changed')::boolean and (select count(*) from public.data_sharing_consents where user_id = u) = 1
     and (select revoked_at is null from public.data_sharing_consents where user_id = u), 're-grant reactivates';

  -- Per partner: sandbox and active partners accepted; revoke allowed after the partner is disabled.
  r := public.fn_set_health_consent(t, u2, 'partner_results', 'activelab', 'grant', 'partner_link_confirm', 'v1', 'sr', 'user', u2, 'req-8');
  assert (r ->> 'changed')::boolean and r ->> 'resource_type' = 'partner_integration' and r ->> 'scope' = 'result_ingestion', 'active partner granted';
  update public.partner_registry set status = 'disabled' where partner_key = 'activelab';
  r := public.fn_set_health_consent(t, u2, 'partner_results', 'activelab', 'revoke', null, null, null, 'user', u2, 'req-9');
  assert (r ->> 'changed')::boolean, 'revoke works for a disabled partner';
  r := public.fn_set_health_consent(t, u2, 'wearables', 'oura', 'grant', 'settings_privacy', 'v1', 'de', 'user', u2, 'req-10');
  assert (r ->> 'changed')::boolean and r ->> 'resource_type' = 'health_source' and r ->> 'scope' = 'ingestion', 'per-connector consent';

  -- Legacy route on the legacy DoctorBox row: stays one row, version labelled.
  r := public.fn_set_health_consent(t, legacy_user, 'partner_results', 'doctorbox', 'grant', 'settings_connected_apps', 'legacy-03885', null, 'user', legacy_user, 'req-11');
  assert (r ->> 'changed')::boolean, 'legacy re-grant records the legacy label';
  assert (select count(*) from public.data_sharing_consents where user_id = legacy_user) = 1, 'legacy row reused';
  assert (select text_version || '/' || category_key from public.data_sharing_consents where user_id = legacy_user) = 'legacy-03885/partner_results', 'legacy label stored';
  r := public.fn_set_health_consent(t, legacy_user, 'partner_results', 'doctorbox', 'grant', 'settings_connected_apps', 'legacy-03885', null, 'user', legacy_user, 'req-12');
  assert not (r ->> 'changed')::boolean, 'legacy re-grant is idempotent';

  -- Append-only: UPDATE raises, even for the table owner.
  assert pg_temp.rejected(format($q$update public.data_sharing_consent_events set action = 'grant' where user_id = %L$q$, u)), 'events cannot be updated';
  assert (select count(*) from public.data_sharing_consent_events where user_id = u and request_id = 'req-4' and action = 'revoke') = 1, 'event unchanged';

  -- The inbox release column exists and nulls out when its order goes.
  assert exists (select 1 from information_schema.columns where table_name = 'partner_health_result_inbox' and column_name = 'consent_order_id'), 'consent_order_id added';
end $$;

-- One transaction: if the event insert fails, the consent is not written.
create function pg_temp.fail_event_insert() returns trigger language plpgsql as $$
begin raise exception 'simulated audit failure'; end $$;
create trigger zz_fail before insert on public.data_sharing_consent_events for each row execute function pg_temp.fail_event_insert();
do $$
declare u uuid := gen_random_uuid();
begin
  assert pg_temp.rejected(format($q$select public.fn_set_health_consent('00000000-0000-0000-0000-0000000000a1', %L, 'wearables', 'fitbit', 'grant', 'settings_privacy', 'v1', 'de', 'user', %L, 'req-x')$q$, u, u)), 'audit failure fails the call';
  assert (select count(*) from public.data_sharing_consents where user_id = u) = 0, 'no consent without its audit row';
end $$;
drop trigger zz_fail on public.data_sharing_consent_events;

-- As the API roles: the privileges hold for real statements, not only in the catalog.
set role authenticated;
do $$ begin
  assert pg_temp.rejected($q$insert into public.data_sharing_consents (tenant_id, user_id, resource_type, resource_id, scope, granted_via) values (gen_random_uuid(), gen_random_uuid(), 'health_category', 'ai_health_analysis', 'processing', 'settings_privacy')$q$), 'authenticated cannot insert a consent';
  assert pg_temp.rejected($q$select public.fn_set_health_consent(gen_random_uuid(), gen_random_uuid(), 'ai_health_analysis', null, 'grant', 'settings_privacy', 'v1', 'de', 'user', null, null)$q$), 'authenticated cannot call the function';
end $$;
reset role;
set role service_role;
do $$ begin
  assert pg_temp.rejected($q$delete from public.data_sharing_consent_events$q$), 'service_role cannot delete events';
  assert pg_temp.rejected($q$update public.data_sharing_consent_events set actor_role = 'x'$q$), 'service_role cannot update events';
  assert (public.fn_set_health_consent('00000000-0000-0000-0000-0000000000a1', gen_random_uuid(), 'health_data_analytics', null, 'grant', 'settings_privacy', 'v1', 'fr', 'user', null, 'req-sr') ->> 'changed')::boolean, 'service_role grants through the function';
end $$;
reset role;

-- Account erasure (SECURITY DEFINER owner, VTID-04765) can still delete events.
delete from public.data_sharing_consent_events where request_id = 'req-sr';

\echo 'PASS vtid-05092 health consent categories'
