-- VTID-04886: ops_attention_acks migration on a throwaway local Postgres.
-- Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-ops-attention-acks-test.sh
\set ON_ERROR_STOP on

-- The Supabase roles the migration grants to / revokes from.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

-- Applied twice: idempotent.
\ir ../../../supabase/migrations/20261005100000_vtid_04886_ops_attention_acks.sql
\ir ../../../supabase/migrations/20261005100000_vtid_04886_ops_attention_acks.sql

-- Helper: true when the statement is rejected by a CHECK constraint.
create function pg_temp.rejected(sql text) returns boolean language plpgsql as $$
begin
  execute sql;
  return false;
exception when check_violation or not_null_violation then
  return true;
end $$;

do $$
declare ok_id uuid;
begin
  -- A valid ack and a valid P2 snooze.
  insert into public.ops_attention_acks (env, fingerprint, action, reason, severity, expires_at)
    values ('production', 'production:release:x', 'ack', 'on it', 'P1', now() + interval '1 hour') returning id into ok_id;
  assert ok_id is not null, 'valid ack inserted';
  insert into public.ops_attention_acks (env, fingerprint, action, reason, severity, vtid, expires_at)
    values ('staging', 'staging:cost_budgets:x', 'snooze', 'budget raised', 'P2', 'VTID-05000', now() + interval '24 hours');

  assert pg_temp.rejected($q$insert into public.ops_attention_acks (env, fingerprint, action, reason, expires_at) values ('production','production:a:b','snooze','r ok', now() + interval '25 hours')$q$), 'expiry > 24 h rejected';
  assert pg_temp.rejected($q$insert into public.ops_attention_acks (env, fingerprint, action, reason, expires_at) values ('production','production:a:b','ack','r ok', now() - interval '1 minute')$q$), 'expiry in the past rejected';
  assert pg_temp.rejected($q$insert into public.ops_attention_acks (env, fingerprint, action, reason) values ('production','production:a:b','ack','r ok')$q$), 'expires_at NOT NULL';
  assert pg_temp.rejected($q$insert into public.ops_attention_acks (env, fingerprint, action, expires_at) values ('production','production:a:b','ack', now() + interval '1 hour')$q$), 'reason NOT NULL';
  assert pg_temp.rejected($q$insert into public.ops_attention_acks (env, fingerprint, action, reason, expires_at) values ('production','production:a:b','ack','  ', now() + interval '1 hour')$q$), 'blank reason rejected';
  assert pg_temp.rejected($q$insert into public.ops_attention_acks (env, fingerprint, action, reason, severity, expires_at) values ('production','production:a:b','snooze','r ok','P1', now() + interval '1 hour')$q$), 'P1 snooze rejected';
  assert pg_temp.rejected($q$insert into public.ops_attention_acks (env, fingerprint, action, reason, expires_at) values ('production','production:a:b','mute','r ok', now() + interval '1 hour')$q$), 'unknown action rejected';
  assert pg_temp.rejected($q$insert into public.ops_attention_acks (env, fingerprint, action, reason, expires_at) values ('dev','dev:a:b','ack','r ok', now() + interval '1 hour')$q$), 'unknown env rejected';
  assert pg_temp.rejected($q$insert into public.ops_attention_acks (env, fingerprint, action, reason, vtid, expires_at) values ('production','production:a:b','ack','r ok','05000', now() + interval '1 hour')$q$), 'malformed vtid rejected';

  -- RLS on; anon/authenticated have no privileges; service_role has.
  assert (select relrowsecurity from pg_class where oid = 'public.ops_attention_acks'::regclass), 'RLS enabled';
  assert not has_table_privilege('anon', 'public.ops_attention_acks', 'select'), 'anon cannot read';
  assert not has_table_privilege('authenticated', 'public.ops_attention_acks', 'insert'), 'authenticated cannot write';
  assert has_table_privilege('service_role', 'public.ops_attention_acks', 'insert'), 'service_role can write';
  assert (select count(*) from pg_policies where tablename = 'ops_attention_acks') = 0, 'no client policies';
  assert (select count(*) from public.ops_attention_acks) = 2, 'only the two valid rows exist';
end $$;

\echo 'VTID-04886 ops_attention_acks: all assertions passed'
