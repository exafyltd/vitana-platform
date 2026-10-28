-- BOOTSTRAP-COMMUNITY-MARKETPLACE (Chunk 7) — admin seller suspension.
--
-- Scoped to this feature only, same reasoning as community_listing_seller_
-- blocks: a marketplace-suspended seller can't create new listings and has
-- their existing ones suspended, but this has no effect outside the
-- community marketplace (chat, feed, etc. are all untouched). Deliberately
-- NOT a new column on the shared app_users/profiles tables.

BEGIN;

CREATE TABLE IF NOT EXISTS public.community_marketplace_seller_suspensions (
  seller_user_id UUID PRIMARY KEY REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  suspended_by    UUID,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.community_marketplace_seller_suspensions IS
  'BOOTSTRAP-COMMUNITY-MARKETPLACE: presence of a row means the seller cannot create new community_listings and their existing ones are forced to status=suspended. Admin-only (service-role client) — no RLS policy needed beyond enabling it.';

CREATE INDEX IF NOT EXISTS idx_cmss_tenant ON public.community_marketplace_seller_suspensions (tenant_id);

ALTER TABLE public.community_marketplace_seller_suspensions ENABLE ROW LEVEL SECURITY;

-- No user-facing policy: only the gateway's service-role client reads/writes
-- this table (admin routes + the create-listing suspension gate), same
-- pattern as listing_status_history.

COMMIT;
