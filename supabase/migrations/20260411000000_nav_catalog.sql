-- =============================================================================
-- VTID-NAV-02: Navigator Catalog Database Schema
-- =============================================================================
-- Migrates the Vitana Navigator catalog from a static TypeScript constant
-- (services/gateway/src/lib/navigation-catalog.ts) to DB-backed tables so
-- Community Admin users can add/edit screens and their trigger phrases at
-- runtime without redeploying the gateway.
--
-- Schema:
--   nav_catalog            — one row per (screen_id, tenant_id). tenant_id IS
--                            NULL means "shared across all tenants" (this is
--                            the default for the ~38 entries that exist today).
--                            A non-null tenant_id row with the same screen_id
--                            is a per-tenant override that replaces the shared
--                            entry for that tenant at scoring time.
--   nav_catalog_i18n       — one row per (catalog_id, lang). English (`en`) is
--                            required; other languages optional and fall back
--                            to English via the consult service.
--   nav_catalog_audit      — append-only edit history. Every create/update/
--                            delete writes a row with before/after JSONB so
--                            admins can review and revert.
--
-- Scoring rules beyond `when_to_visit` (see navigator-consult.ts):
--   context_rules JSONB     — exclude_routes[], require_memory_goal, boost_if,
--                             etc. Structured but free-form; lifted into the
--                             admin UI as dedicated fields.
--   override_triggers JSONB — list of { lang, phrase, active } entries that
--                             force the screen to win with synthetic high
--                             confidence, bypassing normal scoring. Fixes
--                             "wrong screen" issues immediately for specific
--                             phrasings without tuning the scorer.
--
-- Tenant override uniqueness is enforced by two partial unique indexes:
--   - at most one shared (tenant_id IS NULL) row per screen_id
--   - at most one per-tenant row per (screen_id, tenant_id)
--
-- RLS: strictly service-role read/write. The admin API is the sole entrypoint
-- for writes and already gates on exafy_admin.
-- =============================================================================

-- ── nav_catalog ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.nav_catalog (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  screen_id        TEXT NOT NULL,
  -- tenant_id is nullable on purpose: NULL = shared across all tenants.
  -- FK omitted intentionally so this migration is safe to run regardless of
  -- whether tenants.id is UUID or TEXT across environments; the admin API
  -- validates tenant existence before write.
  tenant_id        UUID NULL,
  route            TEXT NOT NULL,
  category         TEXT NOT NULL,
  access           TEXT NOT NULL CHECK (access IN ('public', 'authenticated')),
  anonymous_safe   BOOLEAN NOT NULL DEFAULT FALSE,
  priority         INTEGER NOT NULL DEFAULT 0,
  related_kb_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  context_rules    JSONB NOT NULL DEFAULT '{}'::jsonb,
  override_triggers JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by       UUID NULL
);

-- Partial unique indexes enforce the shared-vs-tenant override model.
-- Postgres NULLs aren't considered equal in unique constraints, so we split.
CREATE UNIQUE INDEX IF NOT EXISTS nav_catalog_screen_shared_uq
  ON public.nav_catalog (screen_id)
  WHERE tenant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS nav_catalog_screen_tenant_uq
  ON public.nav_catalog (screen_id, tenant_id)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS nav_catalog_tenant_idx
  ON public.nav_catalog (tenant_id)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS nav_catalog_category_idx
  ON public.nav_catalog (category);

CREATE INDEX IF NOT EXISTS nav_catalog_active_idx
  ON public.nav_catalog (is_active)
  WHERE is_active = TRUE;

COMMENT ON TABLE public.nav_catalog IS
  'VTID-NAV-02: Vitana Navigator catalog. DB-backed replacement for the static NAVIGATION_CATALOG constant.';
COMMENT ON COLUMN public.nav_catalog.tenant_id IS
  'NULL = shared across all tenants. Non-null = tenant-specific override of the shared entry with the same screen_id.';
COMMENT ON COLUMN public.nav_catalog.context_rules IS
  'JSONB shape: { exclude_on_routes: string[], require_goal_match: string[], boost_if_recent_topic: string[] }';
COMMENT ON COLUMN public.nav_catalog.override_triggers IS
  'JSONB array: [{ lang: string, phrase: string, active: boolean }]. Exact-match bypass rules that force this screen to win.';

-- ── nav_catalog_i18n ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.nav_catalog_i18n (
  catalog_id     UUID NOT NULL REFERENCES public.nav_catalog(id) ON DELETE CASCADE,
  lang           TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  when_to_visit  TEXT NOT NULL DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (catalog_id, lang)
);

CREATE INDEX IF NOT EXISTS nav_catalog_i18n_lang_idx
  ON public.nav_catalog_i18n (lang);

COMMENT ON TABLE public.nav_catalog_i18n IS
  'Localized title/description/when_to_visit for nav_catalog entries. `when_to_visit` is the primary trigger phrase text the Navigator scorer matches against.';

-- ── nav_catalog_audit ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.nav_catalog_audit (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id     UUID NULL,
  screen_id      TEXT NULL,
  tenant_id      UUID NULL,
  action         TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore')),
  before         JSONB NULL,
  after          JSONB NULL,
  actor_user_id  UUID NULL,
  actor_email    TEXT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS nav_catalog_audit_catalog_idx
  ON public.nav_catalog_audit (catalog_id, created_at DESC);

CREATE INDEX IF NOT EXISTS nav_catalog_audit_screen_idx
  ON public.nav_catalog_audit (screen_id, created_at DESC);

COMMENT ON TABLE public.nav_catalog_audit IS
  'Append-only edit history for nav_catalog. Every admin write produces one row; supports revert via /api/v1/admin/navigator/catalog/:id/restore/:audit_id.';

-- ── updated_at trigger ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.nav_catalog_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nav_catalog_touch_updated_at ON public.nav_catalog;
CREATE TRIGGER nav_catalog_touch_updated_at
  BEFORE UPDATE ON public.nav_catalog
  FOR EACH ROW
  EXECUTE FUNCTION public.nav_catalog_touch_updated_at();

DROP TRIGGER IF EXISTS nav_catalog_i18n_touch_updated_at ON public.nav_catalog_i18n;
CREATE TRIGGER nav_catalog_i18n_touch_updated_at
  BEFORE UPDATE ON public.nav_catalog_i18n
  FOR EACH ROW
  EXECUTE FUNCTION public.nav_catalog_touch_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.nav_catalog          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nav_catalog_i18n     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nav_catalog_audit    ENABLE ROW LEVEL SECURITY;

-- Admin (exafy_admin) can read everything. Writes go through the service
-- role via the admin API; no authenticated-user writes are permitted.
DO $$ BEGIN
  CREATE POLICY admin_read_nav_catalog ON public.nav_catalog
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY admin_read_nav_catalog_i18n ON public.nav_catalog_i18n
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY admin_read_nav_catalog_audit ON public.nav_catalog_audit
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The gateway's service role bypasses RLS for writes; the admin API layer
-- is the sole place that validates exafy_admin before touching these tables.
