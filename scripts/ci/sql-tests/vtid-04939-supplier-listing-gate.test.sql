-- VTID-04939: the supplier go-live gate (migration 20261001120000, VTID-04769) keeps
-- products of allowlisted test/service/reviewer accounts out of Discover.
-- Throwaway Postgres only. Run: scripts/ci/sql-tests/run-supplier-listing-gate-test.sh
\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

-- Minimal stand-ins for the tables the migration reads (columns it uses only).
create table public.partner_organizations (id uuid primary key default gen_random_uuid(), lifecycle_state text not null default 'draft', owner_user_id uuid);
create table public.merchants (id uuid primary key default gen_random_uuid(), partner_organization_id uuid references public.partner_organizations(id), owner_user_id uuid);
create table public.products (id uuid primary key default gen_random_uuid(), merchant_id uuid references public.merchants(id), is_active boolean not null default false, updated_at timestamptz default now());
create table public.service_bot_accounts (user_id uuid primary key);
create table public.notification_test_actors (user_id uuid primary key);

\ir ../../../supabase/migrations/20261001120000_vtid_04769_supplier_go_live_lists_products.sql

do $$
declare
  reviewer uuid := gen_random_uuid();   -- registered in service_bot_accounts
  actor    uuid := gen_random_uuid();   -- registered in notification_test_actors
  member   uuid := gen_random_uuid();   -- a real supplier
  late     uuid := gen_random_uuid();   -- registered only after listing
  o uuid; m uuid; p uuid; active boolean; hold text;
begin
  insert into public.service_bot_accounts (user_id) values (reviewer);
  insert into public.notification_test_actors (user_id) values (actor);

  -- 1. A LIVE org owned by the reviewer: a new product never goes active.
  insert into public.partner_organizations (lifecycle_state, owner_user_id) values ('live', reviewer) returning id into o;
  insert into public.merchants (partner_organization_id, owner_user_id) values (o, reviewer) returning id into m;
  assert public.supplier_listing_block(m) = 'excluded_account', 'reviewer merchant is excluded_account';
  insert into public.products (merchant_id, is_active) values (m, true) returning id into p;
  select is_active into active from public.products where id = p;
  assert active = false, 'reviewer product forced inactive on insert';
  -- An admin switch-on is held, with the reason recorded.
  update public.products set is_active = true where id = p;
  select is_active, listing_hold into active, hold from public.products where id = p;
  assert active = false and hold = 'excluded_account', 'reviewer product switch-on is held as excluded_account';

  -- 2. Same for an account in notification_test_actors.
  insert into public.partner_organizations (lifecycle_state, owner_user_id) values ('live', actor) returning id into o;
  insert into public.merchants (partner_organization_id, owner_user_id) values (o, actor) returning id into m;
  insert into public.products (merchant_id, is_active) values (m, true) returning id into p;
  select is_active into active from public.products where id = p;
  assert active = false, 'test-actor product forced inactive on insert';

  -- 3. A real live supplier is unaffected (the gate does not over-block).
  insert into public.partner_organizations (lifecycle_state, owner_user_id) values ('live', member) returning id into o;
  insert into public.merchants (partner_organization_id, owner_user_id) values (o, member) returning id into m;
  assert public.supplier_listing_block(m) = 'eligible', 'real live supplier is eligible';
  insert into public.products (merchant_id, is_active) values (m, false) returning id into p;
  select is_active into active from public.products where id = p;
  assert active = true, 'real live supplier product goes active';

  -- 4. Registering an owner AFTER the product is active switches it off.
  insert into public.partner_organizations (lifecycle_state, owner_user_id) values ('live', late) returning id into o;
  insert into public.merchants (partner_organization_id, owner_user_id) values (o, late) returning id into m;
  insert into public.products (merchant_id, is_active) values (m, false) returning id into p;
  select is_active into active from public.products where id = p;
  assert active = true, 'late account product is active before registration';
  insert into public.service_bot_accounts (user_id) values (late);
  select is_active, listing_hold into active, hold from public.products where id = p;
  assert active = false and hold = 'excluded_account', 'registering the owner later switches the product off';

  -- 5. An org that goes live after creation does not activate a reviewer product.
  insert into public.partner_organizations (lifecycle_state, owner_user_id) values ('draft', reviewer) returning id into o;
  insert into public.merchants (partner_organization_id, owner_user_id) values (o, reviewer) returning id into m;
  insert into public.products (merchant_id) values (m) returning id into p;
  update public.partner_organizations set lifecycle_state = 'live' where id = o;
  select is_active into active from public.products where id = p;
  assert active = false, 'going live does not activate a reviewer product';
end $$;

select 'PASS vtid-04939 supplier listing gate excludes allowlisted owners' as result;
