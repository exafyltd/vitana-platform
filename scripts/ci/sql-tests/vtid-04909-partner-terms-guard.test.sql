-- VTID-04909: the German-binding migration refuses to run unless the partner
-- terms tables are empty, and changes nothing when it refuses.
-- Run by run-partner-terms-test.sh, which expects this file's LAST step to fail.
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
insert into public.partner_terms_versions (version, content) values ('draft', '{"en":{"title":"T","body_md":"B"}}');
\echo 'GUARD-SETUP-DONE'
\ir ../../../supabase/migrations/20261006120000_vtid_04909_partner_terms_german_binding.sql
\echo 'GUARD-DID-NOT-REFUSE'
