-- VTID-05164 (Health Hub Phase 1 / C1): the Health Sync consent keys and phone
-- health-store connectors migration on a throwaway local Postgres.
-- Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-health-sync-consent-test.sh
--
-- Applies, in repository order, the migrations it builds on: the connector
-- framework (VTID-02100) + the ai_assistant category widening (VTID-02403,
-- reproduced below without its unrelated tables), VTID-05092 (catalogue,
-- granted_via CHECK, fn_set_health_consent) and VTID-05156 (the legacy
-- consent-free RPC revoked), then VTID-05164 twice (idempotent).
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $f$ select null::uuid $f$;

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


-- Rows granted under every VTID-05092 granted_via value must stay valid.
insert into public.data_sharing_consents (tenant_id, user_id, resource_type, resource_id, scope, granted_via)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
          'partner_integration', 'doctorbox', 'result_ingestion', 'settings_connected_apps');

-- Connector framework (VTID-02100) as the repository defines it.
\ir ../../../supabase/migrations/20260417000000_vtid_02100_connector_framework.sql
\ir ../../../supabase/migrations/20260417000100_vtid_02100_connector_registry_seed.sql
\ir ../../../supabase/migrations/20260417010000_vtid_02100_connector_registry_update.sql
-- VTID-02403's widening of the category CHECK (its tables are not under test).
do $w$ declare c record; begin
  for c in select conname from pg_constraint where conrelid = 'public.connector_registry'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%category%' loop
    execute format('alter table public.connector_registry drop constraint %I', c.conname);
  end loop;
end $w$;
alter table public.connector_registry add constraint connector_registry_category_check
  check (category in ('social','wearable','shop','calendar','productivity','aggregator','ai_assistant'));
insert into public.connector_registry (id, category, display_name, auth_type) values ('chatgpt', 'ai_assistant', 'ChatGPT', 'api_key');

-- The legacy consent-free RPC, granted as VTID-01078 granted it, then VTID-05156.
create function public.health_ingest_wearable_samples(p_payload jsonb) returns jsonb
  language sql security definer as $f$ select '{}'::jsonb $f$;
grant execute on function public.health_ingest_wearable_samples(jsonb) to authenticated;
\ir ../../../supabase/migrations/20261014120000_vtid_05156_revoke_wearable_samples_rpc.sql

\ir ../../../supabase/migrations/20261012180000_vtid_05092_health_consent_categories.sql

-- VTID-05164, applied twice: idempotent.
\ir ../../../supabase/migrations/20261014130000_vtid_05164_health_sync_consent_keys.sql
\ir ../../../supabase/migrations/20261014130000_vtid_05164_health_sync_consent_keys.sql

create function pg_temp.rejected(sql text) returns boolean language plpgsql as $$
begin
  execute sql;
  return false;
exception when others then
  return true;
end $$;

do $$
declare
  t uuid := '00000000-0000-0000-0000-0000000000a1';
  u uuid := gen_random_uuid();
  r jsonb;
  v text;
  fn regprocedure := 'public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text)'::regprocedure;
begin
  -- 1. The five Phase 1 keys (S7), after the five D10 keys.
  assert (select array_agg(key order by sort) from public.health_consent_categories)
       = array['wearables', 'partner_results', 'ai_health_analysis', 'health_data_analytics', 'community_insights',
               'sync_activity', 'sync_sleep', 'sync_heart', 'sync_body', 'self_logged_health'], 'ten keys in order';
  assert (select count(*) from public.health_consent_categories
           where key in ('sync_activity', 'sync_sleep', 'sync_heart', 'sync_body')
             and resource_type = 'health_source' and scope = 'ingestion:' || substr(key, 6) and per_resource
             and current_text_version = 'v1' and processing_active and active) = 4, 'sync_* rows';
  assert (select resource_type = 'health_category' and scope = 'ingestion:self_logged' and not per_resource and processing_active
            from public.health_consent_categories where key = 'self_logged_health'), 'self_logged_health row';
  -- the D10 rows are untouched
  assert (select count(*) from public.health_consent_categories where processing_active and key in ('wearables', 'ai_health_analysis', 'health_data_analytics', 'community_insights')) = 0, 'D10 rows unchanged';
  -- a later version bump survives a re-apply (ON CONFLICT DO NOTHING)
  update public.health_consent_categories set current_text_version = 'v2' where key = 'sync_sleep';
end $$;

\ir ../../../supabase/migrations/20261014130000_vtid_05164_health_sync_consent_keys.sql

do $$
declare
  t uuid := '00000000-0000-0000-0000-0000000000a1';
  u uuid := gen_random_uuid();
  r jsonb;
  v text;
  def text;
  fn regprocedure := 'public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text)'::regprocedure;
begin
  assert (select current_text_version from public.health_consent_categories where key = 'sync_sleep') = 'v2', 'seed never resets a version';
  update public.health_consent_categories set current_text_version = 'v1' where key = 'sync_sleep';

  -- 2. Connector rows and the category CHECK superset.
  assert (select count(*) from public.connector_registry
           where id in ('apple_health', 'health_connect') and category = 'health_store' and auth_type = 'sdk_bridge' and not enabled) = 2, 'phone store connector rows (disabled)';
  assert (select requires_ios_companion from public.connector_registry where id = 'apple_health'), 'apple_health needs the iOS app';
  foreach v in array array['social','wearable','shop','calendar','productivity','aggregator','ai_assistant','health_store'] loop
    assert not pg_temp.rejected(format($q$insert into public.connector_registry (id, category, display_name, auth_type) values (%L, %L, 'x', 'api_key')$q$, 'probe_' || v, v)), 'category accepted: ' || v;
  end loop;
  assert pg_temp.rejected($q$insert into public.connector_registry (id, category, display_name, auth_type) values ('probe_bogus', 'bogus', 'x', 'api_key')$q$), 'unknown category rejected';
  assert (select count(*) from pg_constraint where conrelid = 'public.connector_registry'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%category%') = 1, 'one category check';
  assert (select count(*) from public.connector_registry where id = 'chatgpt' and category = 'ai_assistant') = 1, 'existing rows kept';

  -- 3. granted_via: the VTID-05092 values plus native_health_sync, nothing else.
  foreach v in array array['checkout_flow', 'settings_connected_apps', 'portal_admin_backfill', 'settings_privacy', 'partner_link_confirm', 'native_health_sync'] loop
    assert not pg_temp.rejected(format($q$insert into public.data_sharing_consents (tenant_id, user_id, resource_type, resource_id, scope, granted_via) values (%L, %L, 'probe', %L, 'probe', %L)$q$, t, u, v, v)), 'granted_via accepted: ' || v;
  end loop;
  assert pg_temp.rejected(format($q$insert into public.data_sharing_consents (tenant_id, user_id, resource_type, resource_id, scope, granted_via) values (%L, %L, 'probe', 'bogus', 'probe', 'bogus')$q$, t, u)), 'unknown granted_via rejected';
  assert (select count(*) from pg_constraint where conrelid = 'public.data_sharing_consents'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%granted_via%') = 1, 'one granted_via check';
  delete from public.data_sharing_consents where resource_type = 'probe';

  -- 4. fn_set_health_consent: native_health_sync, per-source sync_* consents, one self-logged consent.
  r := public.fn_set_health_consent(t, u, 'sync_activity', 'apple_health', 'grant', 'native_health_sync', 'v1', 'de', 'user', u, 'req-1');
  assert r->>'ok' = 'true' and r->>'changed' = 'true', 'sync_activity granted: ' || r::text;
  assert (select count(*) from public.data_sharing_consents
           where user_id = u and resource_type = 'health_source' and resource_id = 'apple_health' and scope = 'ingestion:activity'
             and category_key = 'sync_activity' and granted_via = 'native_health_sync' and text_version = 'v1' and revoked_at is null) = 1, 'sync_activity row';
  assert (select count(*) from public.data_sharing_consent_events where user_id = u and category_key = 'sync_activity' and action = 'grant') = 1, 'grant event in the same transaction';
  -- per source: Health Connect sleep is a separate consent from Apple Health sleep
  r := public.fn_set_health_consent(t, u, 'sync_sleep', 'health_connect', 'grant', 'settings_privacy', 'v1', 'en', 'user', u, null);
  assert r->>'ok' = 'true', 'sync_sleep for health_connect';
  assert (select count(*) from public.data_sharing_consents where user_id = u and scope = 'ingestion:sleep' and resource_id = 'apple_health') = 0, 'no apple_health sleep consent';
  -- a wearables consent for the same connector id is a different row (different scope)
  r := public.fn_set_health_consent(t, u, 'wearables', 'apple_health', 'grant', 'settings_connected_apps', 'v1', 'de', 'user', u, null);
  assert (select count(*) from public.data_sharing_consents where user_id = u and resource_id = 'apple_health') = 2, 'wearables and sync_activity are separate';
  r := public.fn_set_health_consent(t, u, 'sync_heart', null, 'grant', 'native_health_sync', 'v1', 'de', 'user', u, null);
  assert r->>'code' = 'resource_required', 'sync_* needs a resource';
  r := public.fn_set_health_consent(t, u, 'sync_body', 'apple_health', 'grant', 'bogus', 'v1', 'de', 'user', u, null);
  assert r->>'code' = 'invalid_granted_via', 'unknown granted_via refused by the function';
  r := public.fn_set_health_consent(t, u, 'sync_body', 'apple_health', 'grant', 'native_health_sync', 'v0', 'de', 'user', u, null);
  assert r->>'code' = 'stale_text_version', 'stale wording refused';
  r := public.fn_set_health_consent(t, u, 'self_logged_health', 'diary', 'grant', 'settings_privacy', 'v1', 'de', 'user', u, null);
  assert r->>'code' = 'unknown_resource', 'self_logged_health has no resource';
  r := public.fn_set_health_consent(t, u, 'self_logged_health', null, 'grant', 'settings_privacy', 'v1', 'de', 'user', u, null);
  assert r->>'ok' = 'true' and r->>'resource_id' = 'self_logged_health' and r->>'scope' = 'ingestion:self_logged', 'self_logged_health granted';
  -- withdrawal works
  r := public.fn_set_health_consent(t, u, 'sync_activity', 'apple_health', 'revoke', null, null, 'de', 'user', u, null);
  assert r->>'changed' = 'true', 'revoke';
  assert (select revoked_at is not null from public.data_sharing_consents where user_id = u and scope = 'ingestion:activity'), 'revoked';
  -- the D10 behaviour is unchanged
  r := public.fn_set_health_consent(t, u, 'partner_results', 'gonelab', 'grant', 'partner_link_confirm', 'v1', 'de', 'user', u, null);
  assert r->>'code' = 'unknown_resource', 'disabled partner still refused';
  r := public.fn_set_health_consent(t, u, 'partner_results', 'doctorbox', 'grant', 'partner_link_confirm', 'legacy-03885', 'de', 'user', u, null);
  assert r->>'ok' = 'true', 'legacy label still allowed for partner_results';

  -- 5. Privileges: the function stays service_role only.
  assert not has_function_privilege('authenticated', fn, 'execute'), 'authenticated cannot execute fn_set_health_consent';
  assert not has_function_privilege('anon', fn, 'execute'), 'anon cannot execute fn_set_health_consent';
  assert has_function_privilege('service_role', fn, 'execute'), 'service_role executes fn_set_health_consent';
  assert (select prosecdef from pg_proc where oid = fn), 'still SECURITY DEFINER';

  -- 6. The legacy consent-free ingest path stays closed (VTID-05156).
  assert not has_function_privilege('authenticated', 'public.health_ingest_wearable_samples(jsonb)', 'execute'), 'members cannot call health_ingest_wearable_samples';
  assert not has_function_privilege('anon', 'public.health_ingest_wearable_samples(jsonb)', 'execute'), 'anon cannot call health_ingest_wearable_samples';
  assert not has_function_privilege('public', 'public.health_ingest_wearable_samples(jsonb)', 'execute'), 'PUBLIC cannot call health_ingest_wearable_samples';

  -- 7. No consent defaults to granted: the migration inserted no consent row.
  assert (select count(*) from public.data_sharing_consents where category_key like 'sync_%' and user_id <> u) = 0, 'no consent row seeded';
end $$;

\echo PASS vtid-05164 health sync consent
