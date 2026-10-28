-- VTID-04933: "keep offline" / "allow listing" ride on the VTID-04769 go-live
-- gate. Throwaway local Postgres only — never a shared or production database.
-- Run: scripts/ci/sql-tests/run-partner-review-test.sh
\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

-- Minimal stand-ins for the tables the VTID-04769 migration builds on.
create table public.partner_organizations (id uuid primary key default gen_random_uuid(), owner_user_id uuid, lifecycle_state text not null default 'draft');
create table public.merchants (id uuid primary key default gen_random_uuid(), partner_organization_id uuid, owner_user_id uuid);
create table public.products (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  title text,
  is_active boolean not null default false,
  attributes jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);
create table public.service_bot_accounts (user_id uuid primary key);
create table public.notification_test_actors (user_id uuid primary key);

\ir ../../../supabase/migrations/20261001120000_vtid_04769_supplier_go_live_lists_products.sql

insert into partner_organizations (id, owner_user_id, lifecycle_state) values ('00000000-0000-0000-0000-0000000000a1', gen_random_uuid(), 'needs_action');
insert into merchants (id, partner_organization_id) values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1');
-- What the Commerce MCP add_product does: insert hidden.
insert into products (id, merchant_id, title, is_active) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'kept offline', false),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b1', 'waiting', false),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000b1', 'allowed early', false);

do $$
declare r record;
begin
  -- Drafts wait for the org.
  select * into r from products where id = '00000000-0000-0000-0000-0000000000c1';
  if r.is_active or r.first_listed_at is not null or r.listing_hold is not null then raise exception 'draft not waiting: %', row_to_json(r); end if;

  -- keep-offline: what POST …/keep-offline writes.
  update products set is_active = false, attributes = attributes || '{"admin_listing":{"decision":"kept_offline"}}'
   where id = '00000000-0000-0000-0000-0000000000c1';
  select * into r from products where id = '00000000-0000-0000-0000-0000000000c1';
  if r.is_active or r.first_listed_at is null or r.listing_hold is not null then raise exception 'keep-offline not recorded as an admin decision: %', row_to_json(r); end if;

  -- allow-listing while the org is not live: held, on with the org.
  update products set is_active = true where id = '00000000-0000-0000-0000-0000000000c3';
  select * into r from products where id = '00000000-0000-0000-0000-0000000000c3';
  if r.is_active or r.listing_hold is distinct from 'org_not_live' then raise exception 'allow-listing not held: %', row_to_json(r); end if;

  -- The org goes live.
  update partner_organizations set lifecycle_state = 'live' where id = '00000000-0000-0000-0000-0000000000a1';
  if (select is_active from products where id = '00000000-0000-0000-0000-0000000000c1') then raise exception 'kept-offline product went on at go-live'; end if;
  if not (select is_active from products where id = '00000000-0000-0000-0000-0000000000c2') then raise exception 'waiting draft did not go on at go-live'; end if;
  if not (select is_active from products where id = '00000000-0000-0000-0000-0000000000c3') then raise exception 'allowed product did not go on with the org'; end if;

  -- allow-listing a kept-offline product once the org is live: on at once.
  update products set is_active = true where id = '00000000-0000-0000-0000-0000000000c1';
  if not (select is_active from products where id = '00000000-0000-0000-0000-0000000000c1') then raise exception 'allow-listing on a live org did not list'; end if;

  -- keep-offline on a live listing: off, and stays off through pause and resume.
  update products set is_active = false where id = '00000000-0000-0000-0000-0000000000c2';
  update partner_organizations set lifecycle_state = 'paused' where id = '00000000-0000-0000-0000-0000000000a1';
  update partner_organizations set lifecycle_state = 'live' where id = '00000000-0000-0000-0000-0000000000a1';
  if (select is_active from products where id = '00000000-0000-0000-0000-0000000000c2') then raise exception 'kept-offline product came back after pause/resume'; end if;
  if not (select is_active from products where id = '00000000-0000-0000-0000-0000000000c1') then raise exception 'listed product did not come back after pause/resume'; end if;
end $$;

\echo PASS vtid-04933 keep offline and allow listing
