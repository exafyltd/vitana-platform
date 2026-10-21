-- BOOTSTRAP-FEATURE-ANNOUNCEMENTS
--
-- Backs the "Brand New Feature" / "Did You Know" News Feed cards
-- (vitana-v1 src/components/home/FeatureAnnouncementCard.tsx) with a real,
-- admin-published system post instead of the temporary hardcoded feed item.
-- One row = one announcement, shown to every user of its tenant until an
-- admin deactivates it — OR, when target_user_ids is set, only to those
-- specific users (a staged test send to one or a few people before widening
-- to the whole tenant). Copy is stored per-locale (jsonb) so the frontend can
-- pick the viewer's language without a translation-key round trip, mirroring
-- how NewsArticleCard already takes plain localized title/description props.
--
-- Written and inserted only via the gateway's admin-only endpoint
-- (services/gateway/src/routes/admin-feature-announcements.ts) — clients
-- only ever SELECT.

create table if not exists public.feature_announcements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  variant text not null check (variant in ('brand-new-feature', 'did-you-know-feature')),
  -- { "en": "...", "de": "..." } — at minimum en + de must be present.
  feature_title jsonb not null,
  description jsonb not null,
  deep_link text not null,
  is_active boolean not null default true,
  -- NULL = every member of tenant_id. Non-null = a staged test send scoped
  -- to exactly these users, so an admin can preview a card + notification
  -- on themselves before publishing tenant-wide.
  target_user_ids uuid[],
  created_by text,
  notified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists feature_announcements_tenant_active_idx
  on public.feature_announcements (tenant_id, is_active, created_at desc);

alter table public.feature_announcements enable row level security;

-- RLS mirrors ai_provider_policies (DATABASE_SCHEMA.md): SELECT for any
-- authenticated user whose user_tenants row matches the announcement's
-- tenant; ALL for service_role (the gateway writes/updates via service role).
drop policy if exists feature_announcements_select_own_tenant on public.feature_announcements;
create policy feature_announcements_select_own_tenant
  on public.feature_announcements
  for select
  to authenticated
  using (
    is_active = true
    and exists (
      select 1 from public.user_tenants ut
      where ut.tenant_id = feature_announcements.tenant_id
        and ut.user_id = auth.uid()
    )
    and (target_user_ids is null or auth.uid() = any(target_user_ids))
  );

drop policy if exists feature_announcements_service_role_all on public.feature_announcements;
create policy feature_announcements_service_role_all
  on public.feature_announcements
  for all
  to service_role
  using (true)
  with check (true);
