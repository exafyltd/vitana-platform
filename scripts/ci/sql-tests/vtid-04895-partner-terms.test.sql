-- VTID-04895: partner terms lifecycle migration on a throwaway local Postgres.
-- Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-partner-terms-test.sh
\set ON_ERROR_STOP on

-- The Supabase roles the migration grants to / revokes from.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

-- Minimal stand-ins for what the migration builds on: partner_organizations,
-- partner_terms_acceptances exactly as VTID-04478 created it, and Supabase
-- Auth's auth.sessions (only the columns the function reads).
create table public.partner_organizations (id uuid primary key default gen_random_uuid());
create table public.partner_terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  partner_organization_id uuid not null references public.partner_organizations(id) on delete cascade,
  terms_version text not null,
  accepted_by uuid not null,
  accepted_at timestamptz not null default now(),
  ip_address text,
  user_agent text,
  constraint partner_terms_acceptances_org_version_uidx unique (partner_organization_id, terms_version)
);
create schema auth;
create table auth.sessions (id uuid primary key, user_id uuid, oauth_client_id uuid);

-- Applied twice: idempotent.
\ir ../../../supabase/migrations/20261005130000_vtid_04895_partner_terms_lifecycle.sql
\ir ../../../supabase/migrations/20261005130000_vtid_04895_partner_terms_lifecycle.sql

-- Helper: true when the statement raises (any error).
create function pg_temp.rejected(sql text) returns boolean language plpgsql as $$
begin
  execute sql;
  return false;
exception when others then
  return true;
end $$;

do $$
declare
  v1 uuid; v2 uuid; v3 uuid; org uuid; org2 uuid; r jsonb; h1 text; h2 text; h3 text;
  user1 uuid := gen_random_uuid();
begin
  -- Drafts need English (binding) title and body; binding locale is English only.
  assert pg_temp.rejected($q$insert into public.partner_terms_versions (version, content) values ('x', '{"de":{"title":"T","body_md":"B"}}')$q$), 'English text required';
  assert pg_temp.rejected($q$insert into public.partner_terms_versions (version, content) values ('x', '{"en":{"title":" ","body_md":"B"}}')$q$), 'blank English title rejected';
  assert pg_temp.rejected($q$insert into public.partner_terms_versions (version, content, binding_locale) values ('x', '{"en":{"title":"T","body_md":"B"}}', 'de')$q$), 'binding locale is English only';
  assert pg_temp.rejected($q$insert into public.partner_terms_versions (version, content, status) values ('x', '{"en":{"title":"T","body_md":"B"}}', 'published')$q$), 'cannot insert as published without publish fields';

  insert into public.partner_terms_versions (version, content, requires_reacceptance)
    values ('2026-10', '{"en":{"title":"Partner Terms","body_md":"Body v1"},"de":{"title":"Partnerbedingungen","body_md":"Text v1"}}', false)
    returning id into v1;

  -- Drafts are editable, and deletable.
  update public.partner_terms_versions set content = '{"en":{"title":"Partner Terms","body_md":"Body v1."}}' where id = v1;

  -- Publish v1. The first version always starts a baseline, even if marked editorial.
  r := public.publish_partner_terms_version(v1, user1);
  h1 := r ->> 'content_sha256';
  assert (r ->> 'requires_reacceptance')::boolean, 'first version forced to require acceptance';
  assert (r ->> 'baseline_version_id')::uuid = v1, 'first version is its own baseline';
  assert h1 = encode(sha256(convert_to('Partner Terms' || E'\n' || 'Body v1.', 'UTF8')), 'hex'), 'hash = sha256(English title \n body)';
  assert (select status from public.partner_terms_versions where id = v1) = 'published', 'v1 published';

  -- Published is immutable, even for the table owner / service role.
  assert pg_temp.rejected(format($q$update public.partner_terms_versions set content = '{"en":{"title":"X","body_md":"Y"}}' where id = %L$q$, v1)), 'published content immutable';
  assert pg_temp.rejected(format($q$update public.partner_terms_versions set version = 'other' where id = %L$q$, v1)), 'published version immutable';
  assert pg_temp.rejected(format($q$update public.partner_terms_versions set content_sha256 = 'x' where id = %L$q$, v1)), 'published hash immutable';
  assert pg_temp.rejected(format($q$update public.partner_terms_versions set status = 'draft' where id = %L$q$, v1)), 'published cannot go back to draft';
  assert pg_temp.rejected(format($q$delete from public.partner_terms_versions where id = %L$q$, v1)), 'published cannot be deleted';
  assert pg_temp.rejected(format($q$select public.publish_partner_terms_version(%L, %L)$q$, v1, user1)), 'cannot publish twice';

  -- Only one published at a time (index), even bypassing the function.
  insert into public.partner_terms_versions (version, content, requires_reacceptance) values ('2026-11', '{"en":{"title":"Partner Terms","body_md":"Body v2 (editorial)"}}', false) returning id into v2;
  assert pg_temp.rejected(format($q$update public.partner_terms_versions set status = 'published', content_sha256 = 'h', published_at = now(), baseline_version_id = %L where id = %L$q$, v2, v2)), 'second published row rejected';

  -- Acceptance of v1: exact version + hash + locale; terms_version filled from the FK.
  insert into public.partner_organizations default values returning id into org;
  insert into public.partner_organizations default values returning id into org2;
  assert pg_temp.rejected(format($q$insert into public.partner_terms_acceptances (partner_organization_id, terms_version, accepted_by, terms_version_id, content_sha256, shown_locale) values (%L, '', %L, %L, 'wrong', 'en')$q$, org, user1, v1)), 'hash mismatch rejected';
  assert pg_temp.rejected(format($q$insert into public.partner_terms_acceptances (partner_organization_id, terms_version, accepted_by, terms_version_id, content_sha256, shown_locale) values (%L, '', %L, %L, %L, 'en')$q$, org, user1, v2, h1)), 'draft version cannot be accepted';
  assert pg_temp.rejected(format($q$insert into public.partner_terms_acceptances (partner_organization_id, terms_version, accepted_by) values (%L, '2026-10', %L)$q$, org, user1)), 'new rows need version id, hash and locale';
  insert into public.partner_terms_acceptances (partner_organization_id, terms_version, accepted_by, terms_version_id, content_sha256, shown_locale)
    values (org, 'ignored', user1, v1, h1, 'en+de');
  assert (select terms_version from public.partner_terms_acceptances where partner_organization_id = org) = '2026-10', 'terms_version filled from the FK';
  assert pg_temp.rejected(format($q$insert into public.partner_terms_acceptances (partner_organization_id, terms_version, accepted_by, terms_version_id, content_sha256, shown_locale) values (%L, '', %L, %L, %L, 'en')$q$, org, user1, v1, h1)), 'one acceptance per org and version';

  -- Append-only.
  assert pg_temp.rejected(format($q$update public.partner_terms_acceptances set shown_locale = 'en' where partner_organization_id = %L$q$, org)), 'acceptances cannot be updated';
  assert pg_temp.rejected(format($q$delete from public.partner_terms_acceptances where partner_organization_id = %L$q$, org)), 'acceptances cannot be deleted directly';

  -- Editorial v2 keeps v1's baseline; v1 is superseded with nothing else changed.
  r := public.publish_partner_terms_version(v2, user1);
  h2 := r ->> 'content_sha256';
  assert not (r ->> 'requires_reacceptance')::boolean, 'v2 editorial';
  assert (r ->> 'baseline_version_id')::uuid = v1, 'editorial keeps the baseline';
  assert (r ->> 'superseded_id')::uuid = v1, 'v1 superseded';
  assert (select status from public.partner_terms_versions where id = v1) = 'superseded', 'v1 is superseded';
  assert (select content_sha256 from public.partner_terms_versions where id = v1) = h1, 'superseding left v1 untouched';
  assert pg_temp.rejected(format($q$insert into public.partner_terms_acceptances (partner_organization_id, terms_version, accepted_by, terms_version_id, content_sha256, shown_locale) values (%L, '', %L, %L, %L, 'en')$q$, org2, user1, v1, h1)), 'a superseded version cannot be accepted any more';
  -- The org that accepted v1 counts as accepted under v2 (same baseline).
  assert exists (
    select 1 from public.partner_terms_acceptances a join public.partner_terms_versions tv on tv.id = a.terms_version_id
    where a.partner_organization_id = org
      and tv.baseline_version_id = (select baseline_version_id from public.partner_terms_versions where status = 'published')
  ), 'v1 acceptance valid under editorial v2';

  -- Material v3 starts a new baseline: the v1 acceptance no longer counts.
  insert into public.partner_terms_versions (version, content, requires_reacceptance)
    values ('2027-01', '{"en":{"title":"Partner Terms","body_md":"Body v3 (material)"}}', true) returning id into v3;
  r := public.publish_partner_terms_version(v3, user1);
  h3 := r ->> 'content_sha256';
  assert (r ->> 'baseline_version_id')::uuid = v3, 'material starts a baseline';
  assert not exists (
    select 1 from public.partner_terms_acceptances a join public.partner_terms_versions tv on tv.id = a.terms_version_id
    where a.partner_organization_id = org
      and tv.baseline_version_id = (select baseline_version_id from public.partner_terms_versions where status = 'published')
  ), 'v1 acceptance does not count under material v3';
  insert into public.partner_terms_acceptances (partner_organization_id, terms_version, accepted_by, terms_version_id, content_sha256, shown_locale)
    values (org, '', user1, v3, h3, 'en');
  assert (select count(*) from public.partner_terms_acceptances where partner_organization_id = org) = 2, 'both acceptances kept (history)';

  -- Deleting the organization still cascades.
  delete from public.partner_organizations where id = org;
  assert (select count(*) from public.partner_terms_acceptances where partner_organization_id = org) = 0, 'org delete cascades';

  -- Delegated-session lookup.
  insert into auth.sessions values ('00000000-0000-0000-0000-000000000001', user1, null);
  insert into auth.sessions values ('00000000-0000-0000-0000-000000000002', user1, gen_random_uuid());
  assert public.auth_session_is_delegated('00000000-0000-0000-0000-000000000001') = 'direct', 'app session is direct';
  assert public.auth_session_is_delegated('00000000-0000-0000-0000-000000000002') = 'delegated', 'OAuth session is delegated';
  assert public.auth_session_is_delegated('00000000-0000-0000-0000-000000000009') = 'unknown', 'missing session is unknown';

  -- Privileges: browsers read published/superseded only and write nothing; RPCs are service-role only.
  assert (select relrowsecurity from pg_class where oid = 'public.partner_terms_versions'::regclass), 'RLS enabled';
  assert not has_table_privilege('authenticated', 'public.partner_terms_versions', 'insert'), 'authenticated cannot write versions';
  assert not has_table_privilege('anon', 'public.partner_terms_versions', 'update'), 'anon cannot write versions';
  assert not has_function_privilege('authenticated', 'public.publish_partner_terms_version(uuid, uuid)', 'execute'), 'authenticated cannot publish';
  assert not has_function_privilege('authenticated', 'public.auth_session_is_delegated(uuid)', 'execute'), 'authenticated cannot probe sessions';
  assert has_function_privilege('service_role', 'public.publish_partner_terms_version(uuid, uuid)', 'execute'), 'service_role can publish';
end $$;

\echo 'PASS vtid-04895 partner terms lifecycle'
