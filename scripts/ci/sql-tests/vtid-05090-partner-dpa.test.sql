-- VTID-05090: partner data processing agreement migration on a throwaway local Postgres.
-- Never run against a shared or production database.
-- Run: scripts/ci/sql-tests/run-partner-terms-test.sh (runs this file too)
\set ON_ERROR_STOP on

-- The Supabase roles the migration grants to / revokes from, with Supabase's
-- default grants (browser roles get everything on new tables unless revoked).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

-- Minimal stand-ins for what the migration builds on: partner_organizations,
-- the membership table and the VTID-04337 helper (same body; current_user_id
-- reads a test setting instead of the JWT).
create table public.partner_organizations (id uuid primary key default gen_random_uuid());
create table public.partner_organization_members (
  partner_organization_id uuid not null references public.partner_organizations(id) on delete cascade,
  user_id uuid not null
);
create function public.current_user_id() returns uuid language sql stable as $$
  select nullif(current_setting('test.user_id', true), '')::uuid
$$;
create function public.is_partner_org_member(p_org_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.partner_organization_members pom
    where pom.partner_organization_id = p_org_id and pom.user_id = public.current_user_id()
  );
$$;

-- Applied twice: idempotent.
\ir ../../../supabase/migrations/20261012200000_vtid_05090_partner_dpa.sql
\ir ../../../supabase/migrations/20261012200000_vtid_05090_partner_dpa.sql

-- Helper: true when the statement raises (any error).
create function pg_temp.rejected(sql text) returns boolean language plpgsql as $$
begin
  execute sql;
  return false;
exception when others then
  return true;
end $$;

-- Helper: the error message a statement raises ('' when it does not raise).
create function pg_temp.error_of(sql text) returns text language plpgsql as $$
begin
  execute sql;
  return '';
exception when others then
  return sqlerrm;
end $$;

do $$
declare
  v1 uuid; v2 uuid; v3 uuid; vx uuid; r jsonb; h1 text; h3 text;
  org uuid := '00000000-0000-0000-0000-0000000000a1';
  org2 uuid := '00000000-0000-0000-0000-0000000000a2';
  user1 uuid := '00000000-0000-0000-0000-0000000000b1';
  snap jsonb := '{"legal_name":"Labor GmbH","country":"DE","vat_id":"DE1","website":"https://lab.example/"}';
  ins text := $q$insert into public.partner_dpa_signatures (partner_organization_id, dpa_version_id, dpa_version, content_sha256, shown_locale, signed_by, signer_email, signer_name, signer_role, declaration_confirmed, org_snapshot) values (%L, %L, '', %L, %L, %L, %L, %L, %L, %L, %L)$q$;
begin
  -- Drafts need German (binding) title and body; binding locale is German only.
  assert pg_temp.rejected($q$insert into public.partner_dpa_versions (version, content) values ('x', '{"en":{"title":"T","body_md":"B"}}')$q$), 'German text required';
  assert pg_temp.rejected($q$insert into public.partner_dpa_versions (version, content) values ('x', '{"de":{"title":" ","body_md":"B"}}')$q$), 'blank German title rejected';
  assert pg_temp.rejected($q$insert into public.partner_dpa_versions (version, content, binding_locale) values ('x', '{"de":{"title":"T","body_md":"B"}}', 'en')$q$), 'binding locale is German only';
  assert pg_temp.rejected($q$insert into public.partner_dpa_versions (version, content, status) values ('x', '{"de":{"title":"T","body_md":"B"}}', 'published')$q$), 'cannot insert as published without publish fields';

  -- A draft without English cannot be published.
  insert into public.partner_dpa_versions (version, content) values ('de-only', '{"de":{"title":"T","body_md":"B"}}') returning id into vx;
  assert pg_temp.error_of(format('select public.publish_partner_dpa_version(%L, %L)', vx, user1)) like '%PARTNER_DPA_ENGLISH_MISSING%', 'English required at publish';
  delete from public.partner_dpa_versions where id = vx; -- drafts are deletable

  insert into public.partner_dpa_versions (version, content, requires_resign)
    values ('avv-1', '{"de":{"title":"AVV","body_md":"Text v1","signing_declaration":"Ich bin berechtigt."},"en":{"title":"DPA","body_md":"Text v1 en"}}', false)
    returning id into v1;
  -- Drafts are editable.
  update public.partner_dpa_versions set content = '{"de":{"title":"AVV","body_md":"Text v1.","signing_declaration":"Ich bin berechtigt."},"en":{"title":"DPA","body_md":"Text v1 en"}}' where id = v1;

  -- Publish v1. The first version always starts a baseline, even if marked editorial.
  r := public.publish_partner_dpa_version(v1, user1);
  h1 := r ->> 'content_sha256';
  assert (r ->> 'requires_resign')::boolean, 'first version forced to require signing';
  assert (r ->> 'baseline_version_id')::uuid = v1, 'first version is its own baseline';
  -- The database computes the hash, and the signing declaration is part of it.
  assert h1 = encode(sha256(convert_to('AVV' || E'\n' || 'Text v1.' || E'\n' || 'Ich bin berechtigt.', 'UTF8')), 'hex'), 'hash = sha256(de.title \n de.body_md \n de.signing_declaration)';
  assert h1 <> encode(sha256(convert_to('AVV' || E'\n' || 'Text v1.', 'UTF8')), 'hex'), 'the declaration changes the hash';
  assert (select status from public.partner_dpa_versions where id = v1) = 'published', 'v1 published';

  -- Published is immutable, even for the table owner / service role.
  assert pg_temp.rejected(format($q$update public.partner_dpa_versions set content = '{"de":{"title":"X","body_md":"Y"}}' where id = %L$q$, v1)), 'published content immutable';
  assert pg_temp.rejected(format($q$update public.partner_dpa_versions set version = 'other' where id = %L$q$, v1)), 'published version immutable';
  assert pg_temp.rejected(format($q$update public.partner_dpa_versions set content_sha256 = 'x' where id = %L$q$, v1)), 'published hash immutable';
  assert pg_temp.rejected(format($q$update public.partner_dpa_versions set status = 'draft' where id = %L$q$, v1)), 'published cannot go back to draft';
  assert pg_temp.rejected(format($q$delete from public.partner_dpa_versions where id = %L$q$, v1)), 'published cannot be deleted';
  assert pg_temp.error_of(format('select public.publish_partner_dpa_version(%L, %L)', v1, user1)) like '%PARTNER_DPA_NOT_DRAFT%', 'cannot publish twice';
  assert pg_temp.error_of(format('select public.publish_partner_dpa_version(%L, %L)', gen_random_uuid(), user1)) like '%PARTNER_DPA_NOT_FOUND%', 'unknown version';

  -- Only one published at a time (index), even bypassing the function.
  insert into public.partner_dpa_versions (version, content, requires_resign) values ('avv-2', '{"de":{"title":"AVV","body_md":"Text v2 (redaktionell)"},"en":{"title":"DPA","body_md":"v2"}}', false) returning id into v2;
  assert pg_temp.rejected(format($q$update public.partner_dpa_versions set status = 'published', content_sha256 = 'h', published_at = now(), baseline_version_id = %L where id = %L$q$, v2, v2)), 'second published row rejected';

  -- Signatures: exact current version + hash; dpa_version filled from the FK.
  insert into public.partner_organizations (id) values (org), (org2);
  assert pg_temp.error_of(format(ins, org, v1, 'wrong', 'de', user1, 'a@lab.example', 'Erika', 'GF', true, snap)) like '%PARTNER_DPA_CONTENT_MISMATCH%', 'hash mismatch rejected';
  assert pg_temp.error_of(format(ins, org, v2, h1, 'de', user1, 'a@lab.example', 'Erika', 'GF', true, snap)) like '%PARTNER_DPA_VERSION_NOT_CURRENT%', 'a draft cannot be signed';
  assert pg_temp.rejected(format(ins, org, v1, h1, 'de', user1, 'a@lab.example', 'Erika', 'GF', false, snap)), 'declaration_confirmed must be true';
  assert pg_temp.rejected(format(ins, org, v1, h1, 'de', user1, ' ', 'Erika', 'GF', true, snap)), 'signer_email required';
  assert pg_temp.rejected(replace(format(ins, org, v1, h1, 'de', user1, 'x', 'Erika', 'GF', true, snap), $s$'x'$s$, 'NULL')), 'signer_email NOT NULL';
  assert pg_temp.rejected(format(ins, org, v1, h1, 'de', user1, 'a@lab.example', '  ', 'GF', true, snap)), 'signer_name required';
  assert pg_temp.rejected(format(ins, org, v1, h1, 'de', user1, 'a@lab.example', 'Erika', '', true, snap)), 'signer_role required';
  assert pg_temp.rejected(format(ins, org, v1, h1, 'pt', user1, 'a@lab.example', 'Erika', 'GF', true, snap)), 'shown_locale must be one of the 11 codes';
  assert pg_temp.rejected(format(ins, org, v1, h1, 'de', user1, 'a@lab.example', 'Erika', 'GF', true, '[]')), 'org_snapshot must be an object';
  execute format(ins, org, v1, h1, 'en', user1, 'a@lab.example', 'Erika', 'GF', true, snap);
  assert (select dpa_version from public.partner_dpa_signatures where partner_organization_id = org) = 'avv-1', 'dpa_version filled from the FK';
  assert pg_temp.error_of(format(ins, org, v1, h1, 'de', user1, 'a@lab.example', 'Erika', 'GF', true, snap)) like '%partner_dpa_signatures_org_version_uidx%', 'one signature per org and version (23505)';

  -- Append-only.
  assert pg_temp.error_of(format($q$update public.partner_dpa_signatures set signer_name = 'X' where partner_organization_id = %L$q$, org)) like '%PARTNER_DPA_SIGNATURE_APPEND_ONLY%', 'signatures cannot be updated';
  assert pg_temp.error_of(format($q$delete from public.partner_dpa_signatures where partner_organization_id = %L$q$, org)) like '%PARTNER_DPA_SIGNATURE_APPEND_ONLY%', 'signatures cannot be deleted directly';

  -- Editorial v2 keeps v1's baseline; v1 is superseded with nothing else changed; v1 can no longer be signed.
  r := public.publish_partner_dpa_version(v2, user1);
  assert not (r ->> 'requires_resign')::boolean, 'v2 editorial';
  assert (r ->> 'baseline_version_id')::uuid = v1, 'editorial keeps the baseline';
  assert (r ->> 'superseded_id')::uuid = v1, 'v1 superseded';
  assert (r ->> 'content_sha256') = encode(sha256(convert_to('AVV' || E'\n' || 'Text v2 (redaktionell)' || E'\n', 'UTF8')), 'hex'), 'no declaration hashes as an empty last line';
  assert (select content_sha256 from public.partner_dpa_versions where id = v1) = h1, 'superseding left v1 untouched';
  assert pg_temp.error_of(format(ins, org2, v1, h1, 'de', user1, 'a@lab.example', 'Erika', 'GF', true, snap)) like '%PARTNER_DPA_VERSION_NOT_CURRENT%', 'a superseded version cannot be signed';

  -- Material v3 starts a new baseline: the v1 signature no longer counts.
  insert into public.partner_dpa_versions (version, content, requires_resign)
    values ('avv-3', '{"de":{"title":"AVV","body_md":"Text v3 (wesentlich)","signing_declaration":"Neu."},"en":{"title":"DPA","body_md":"v3"}}', true) returning id into v3;
  r := public.publish_partner_dpa_version(v3, user1);
  h3 := r ->> 'content_sha256';
  assert (r ->> 'baseline_version_id')::uuid = v3, 'material starts a baseline';
  assert not exists (
    select 1 from public.partner_dpa_signatures s join public.partner_dpa_versions dv on dv.id = s.dpa_version_id
    where s.partner_organization_id = org
      and dv.baseline_version_id = (select baseline_version_id from public.partner_dpa_versions where status = 'published')
  ), 'v1 signature does not count under material v3';
  execute format(ins, org, v3, h3, 'de', user1, 'a@lab.example', 'Erika', 'GF', true, snap);
  assert (select count(*) from public.partner_dpa_signatures where partner_organization_id = org) = 2, 'both signatures kept (history)';

  -- Privileges: browsers read published/superseded versions and their own org's signatures; nobody but service_role publishes.
  assert (select relrowsecurity from pg_class where oid = 'public.partner_dpa_versions'::regclass), 'RLS on versions';
  assert (select relrowsecurity from pg_class where oid = 'public.partner_dpa_signatures'::regclass), 'RLS on signatures';
  assert not has_table_privilege('authenticated', 'public.partner_dpa_versions', 'insert'), 'authenticated cannot write versions';
  assert not has_table_privilege('anon', 'public.partner_dpa_versions', 'update'), 'anon cannot write versions';
  assert not has_table_privilege('authenticated', 'public.partner_dpa_signatures', 'insert'), 'authenticated cannot insert signatures';
  assert not has_table_privilege('authenticated', 'public.partner_dpa_signatures', 'delete'), 'authenticated cannot delete signatures';
  assert not has_table_privilege('anon', 'public.partner_dpa_signatures', 'truncate'), 'anon cannot truncate signatures';
  assert not has_function_privilege('authenticated', 'public.publish_partner_dpa_version(uuid, uuid)', 'execute'), 'authenticated cannot publish';
  assert not has_function_privilege('anon', 'public.publish_partner_dpa_version(uuid, uuid)', 'execute'), 'anon cannot publish';
  assert has_function_privilege('service_role', 'public.publish_partner_dpa_version(uuid, uuid)', 'execute'), 'service_role can publish';

  insert into public.partner_organization_members values (org, user1);
end $$;

-- RLS as a browser: a member sees only their org's signatures and only published/superseded versions.
insert into public.partner_dpa_versions (version, content) values ('draft-x', '{"de":{"title":"T","body_md":"B"}}');
set role authenticated;
do $$ begin perform set_config('test.user_id', '00000000-0000-0000-0000-0000000000b1', false); end $$;
do $$ begin
  assert (select count(*) from public.partner_dpa_signatures) = 2, 'member sees own org signatures';
  assert (select count(*) from public.partner_dpa_signatures where partner_organization_id <> '00000000-0000-0000-0000-0000000000a1') = 0, 'member sees no other org';
  assert (select count(*) from public.partner_dpa_versions where status = 'draft') = 0, 'drafts are invisible to browsers';
  assert (select count(*) from public.partner_dpa_versions) = 3, 'published + superseded versions visible';
end $$;
do $$ begin perform set_config('test.user_id', '00000000-0000-0000-0000-0000000000c9', false); end $$;
do $$ begin
  assert (select count(*) from public.partner_dpa_signatures) = 0, 'a non-member sees no signatures';
end $$;
reset role;

-- Deleting the organization still cascades through the append-only guard.
do $$ begin
  delete from public.partner_organizations where id = '00000000-0000-0000-0000-0000000000a1';
  assert (select count(*) from public.partner_dpa_signatures) = 0, 'org delete cascades';
end $$;

\echo 'PASS vtid-05090 partner dpa lifecycle'
