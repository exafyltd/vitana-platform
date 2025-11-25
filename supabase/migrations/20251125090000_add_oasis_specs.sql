-- OASIS Specs v1: Configuration and specification storage
-- Stores JSON specifications like Developer Screen Inventory

create table if not exists public.oasis_specs (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  env text not null,
  version integer not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes for efficient querying
create index if not exists idx_oasis_specs_key on public.oasis_specs (key);
create index if not exists idx_oasis_specs_env_version on public.oasis_specs (env, version);

-- Enable RLS
alter table public.oasis_specs enable row level security;

-- Allow read access to authenticated users
drop policy if exists "Enable read access for auth users on oasis_specs" on public.oasis_specs;
create policy "Enable read access for auth users on oasis_specs" 
  on public.oasis_specs 
  for select 
  to authenticated 
  using (true);

-- Allow write access ONLY to service_role (backend)
drop policy if exists "Enable write access for service role on oasis_specs" on public.oasis_specs;
create policy "Enable write access for service role on oasis_specs" 
  on public.oasis_specs 
  for all 
  to service_role 
  using (true) 
  with check (true);
