-- VTID-04909: partner terms with German binding, on a throwaway local Postgres.
-- Applies VTID-04895, then VTID-04909, and proves the German rules.
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

\ir ../../../supabase/migrations/20261005130000_vtid_04895_partner_terms_lifecycle.sql
-- Applied twice on the empty state: idempotent.
\ir ../../../supabase/migrations/20261006120000_vtid_04909_partner_terms_german_binding.sql
\ir ../../../supabase/migrations/20261006120000_vtid_04909_partner_terms_german_binding.sql

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
  v1 uuid; v2 uuid; v3 uuid; org uuid; r jsonb; h1 text; h2 text;
  user1 uuid := gen_random_uuid();
  de1 text := '{"de":{"title":"Partnerbedingungen","body_md":"Text v1"},"en":{"title":"Partner Terms","body_md":"Body v1"},"pt-BR":{"title":"Termos","body_md":"Texto"},"zh-CN":{"title":"条款","body_md":"正文"},"ar":{"title":"شروط","body_md":"نص"}}';
begin
  -- German is binding: required, and the only binding locale.
  assert pg_temp.rejected($q$insert into public.partner_terms_versions (version, content) values ('x', '{"en":{"title":"T","body_md":"B"}}')$q$), 'German text required';
  assert pg_temp.rejected($q$insert into public.partner_terms_versions (version, content) values ('x', '{"de":{"title":" ","body_md":"B"}}')$q$), 'blank German title rejected';
  assert pg_temp.rejected($q$insert into public.partner_terms_versions (version, content) values ('x', '{"de":{"title":"T","body_md":""}}')$q$), 'blank German body rejected';
  assert pg_temp.rejected($q$insert into public.partner_terms_versions (version, content, binding_locale) values ('x', '{"de":{"title":"T","body_md":"B"}}', 'en')$q$), 'binding locale is German only';
  assert (select column_default from information_schema.columns where table_name = 'partner_terms_versions' and column_name = 'binding_locale') like '%de%', 'binding_locale defaults to de';

  -- A draft without English can exist, but cannot be published.
  insert into public.partner_terms_versions (version, content) values ('no-en', '{"de":{"title":"T","body_md":"B"}}') returning id into v3;
  begin
    perform public.publish_partner_terms_version(v3, user1);
    assert false, 'publishing without English must fail';
  exception when others then
    assert sqlerrm like '%PARTNER_TERMS_ENGLISH_MISSING%', 'English missing reported: ' || sqlerrm;
  end;
  delete from public.partner_terms_versions where id = v3;

  -- Publish v1: hash = sha256(German title \n German body); exact BCP-47 keys kept.
  insert into public.partner_terms_versions (version, content) values ('2026-10', de1::jsonb) returning id into v1;
  assert (select binding_locale from public.partner_terms_versions where id = v1) = 'de', 'binding_locale de';
  r := public.publish_partner_terms_version(v1, user1);
  h1 := r ->> 'content_sha256';
  assert h1 = encode(sha256(convert_to('Partnerbedingungen' || E'\n' || 'Text v1', 'UTF8')), 'hex'), 'hash = sha256(German title \n body)';
  assert h1 <> encode(sha256(convert_to('Partner Terms' || E'\n' || 'Body v1', 'UTF8')), 'hex'), 'English does not determine the hash';
  assert (select content ? 'pt-BR' and content ? 'zh-CN' from public.partner_terms_versions where id = v1), 'pt-BR and zh-CN stored under their exact codes';

  -- A translation-only correction (new version, editorial): same canonical hash, same baseline.
  insert into public.partner_terms_versions (version, content, requires_reacceptance)
    values ('2026-10a', jsonb_set(de1::jsonb, '{en,body_md}', '"Body v1 (corrected translation)"'), false) returning id into v2;
  r := public.publish_partner_terms_version(v2, user1);
  h2 := r ->> 'content_sha256';
  assert h2 = h1, 'translation-only change leaves the canonical hash unchanged';
  assert (r ->> 'baseline_version_id')::uuid = v1, 'editorial translation fix keeps the baseline';
  assert (select content -> 'en' ->> 'body_md' from public.partner_terms_versions where id = v1) = 'Body v1', 'the earlier version keeps the translation it was published with';

  -- Changing the German title or body changes the hash.
  assert encode(sha256(convert_to('Partnerbedingungen!' || E'\n' || 'Text v1', 'UTF8')), 'hex') <> h1, 'German title change changes hash';
  assert encode(sha256(convert_to('Partnerbedingungen' || E'\n' || 'Text v1!', 'UTF8')), 'hex') <> h1, 'German body change changes hash';

  -- Acceptance: the German hash, any supported language on screen; nothing else.
  insert into public.partner_organizations default values returning id into org;
  assert pg_temp.rejected(format($q$insert into public.partner_terms_acceptances (partner_organization_id, terms_version, accepted_by, terms_version_id, content_sha256, shown_locale) values (%L, '', %L, %L, %L, 'en+de')$q$, org, user1, v2, h2)), 'old en+xx shown_locale rejected';
  assert pg_temp.rejected(format($q$insert into public.partner_terms_acceptances (partner_organization_id, terms_version, accepted_by, terms_version_id, content_sha256, shown_locale) values (%L, '', %L, %L, %L, 'pt')$q$, org, user1, v2, h2)), 'pt is not a supported code';
  assert pg_temp.rejected(format($q$insert into public.partner_terms_acceptances (partner_organization_id, terms_version, accepted_by, terms_version_id, content_sha256, shown_locale) values (%L, '', %L, %L, 'english-hash', 'en')$q$, org, user1, v2)), 'a non-German hash is rejected';
  insert into public.partner_terms_acceptances (partner_organization_id, terms_version, accepted_by, terms_version_id, content_sha256, shown_locale)
    values (org, '', user1, v2, h2, 'zh-CN');
  assert (select content_sha256 from public.partner_terms_acceptances where partner_organization_id = org) = h1, 'acceptance binds the canonical German hash';
  assert pg_temp.rejected(format($q$insert into public.partner_terms_acceptances (partner_organization_id, terms_version, accepted_by, terms_version_id, content_sha256, shown_locale) values (%L, '', %L, %L, %L, 'de')$q$, org, user1, v2, h2)), 'another language on screen is not a second acceptance';
end $$;

\echo 'PASS vtid-04909 partner terms german binding'
