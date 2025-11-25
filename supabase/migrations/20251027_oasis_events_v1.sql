-- OASIS events v1: persistence spine
create table if not exists public.oasis_events_v1 (
  id             bigserial primary key,
  rid            text not null,
  tenant         text not null,
  task_type      text not null,
  assignee_ai    text not null,
  status         text not null check (status in ('planned','running','success','error','aborted')),
  notes          text,
  git_sha        text,
  metadata       jsonb default '{}'::jsonb not null,
  schema_version int default 1 not null,
  created_at     timestamptz not null default now()
);

alter table public.oasis_events_v1 enable row level security;

create or replace function public.current_tenant()
returns text language sql stable as $$
  select coalesce(
    nullif( current_setting('request.jwt.claims', true)::jsonb->>'tenant', '' ),
    '__NO_TENANT__'
  );
$$;

drop policy if exists p_select_events_by_tenant on public.oasis_events_v1;
create policy p_select_events_by_tenant
  on public.oasis_events_v1
  for select
  using (tenant = public.current_tenant());

drop policy if exists p_insert_events_by_tenant on public.oasis_events_v1;
create policy p_insert_events_by_tenant
  on public.oasis_events_v1
  for insert
  with check (tenant = public.current_tenant());

drop policy if exists p_update_events_by_tenant on public.oasis_events_v1;
create policy p_update_events_by_tenant
  on public.oasis_events_v1
  for update
  using (tenant = public.current_tenant())
  with check (tenant = public.current_tenant());

create index if not exists idx_oasis_events_v1_rid              on public.oasis_events_v1 (rid);
create index if not exists idx_oasis_events_v1_tenant_created   on public.oasis_events_v1 (tenant, created_at desc);
create index if not exists idx_oasis_events_v1_status           on public.oasis_events_v1 (status);
