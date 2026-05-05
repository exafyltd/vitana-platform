-- =============================================================================
-- Release Backlog & Versioning v1 (R1 + R3 from Phase 2 ticket plan)
-- =============================================================================
-- Three tables that back the release-tracking system surfaced in Command Hub
-- (/dev/releases) and tenant admin (/admin/releases). Mirrors the routines +
-- routine_runs catalog/history pattern from VTID-01981.
--
-- See specs/release-backlog-overview.md and specs/release-backlog-spec-decisions.md
-- for full design rationale (decisions P1-P5, F1).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- release_components — catalog: one row per shippable thing we version
-- -----------------------------------------------------------------------------
-- Covers BOTH platform components (owner='platform', tenant_id NULL) and
-- tenant-app surfaces (owner='tenant', tenant_id NOT NULL).
--
-- For tenant rows, min_platform_version / target_platform_version refer
-- specifically to the platform.sdk version (P2 — single SDK contract).
-- public_changelog defaults FALSE; surface-derived seed defaults below (P4).
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS release_components (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                     TEXT NOT NULL UNIQUE,
  display_name             TEXT NOT NULL,
  owner                    TEXT NOT NULL
                           CHECK (owner IN ('platform', 'tenant')),
  tenant_id                UUID,
  surface                  TEXT NOT NULL
                           CHECK (surface IN
                             ('command_hub', 'web', 'api', 'sdk', 'desktop', 'ios', 'android')),
  repo                     TEXT,
  current_version          TEXT,
  current_channel          TEXT
                           CHECK (current_channel IN ('internal', 'beta', 'stable')),
  current_released_at      TIMESTAMPTZ,
  current_release_id       UUID,
  -- Compatibility pinning (only meaningful for owner='tenant'):
  min_platform_version     TEXT,
  target_platform_version  TEXT,
  -- Public changelog visibility (P4): surface-derived defaults via seed below.
  public_changelog         BOOLEAN NOT NULL DEFAULT FALSE,
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT release_components_tenant_id_required_for_tenant_owner
    CHECK (
      (owner = 'tenant'   AND tenant_id IS NOT NULL) OR
      (owner = 'platform' AND tenant_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_release_components_owner_tenant
  ON release_components(owner, tenant_id);
CREATE INDEX IF NOT EXISTS idx_release_components_surface
  ON release_components(surface);

-- -----------------------------------------------------------------------------
-- release_history — append-only log of every release event for a component
-- -----------------------------------------------------------------------------
-- The `changelog` column is what the tenant-side Changelog tab authors and
-- what /api/v1/releases/changelog/public serves to App Store / Play Store /
-- in-app /changelog for stable releases (per P4 + P5).
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS release_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id    UUID NOT NULL REFERENCES release_components(id) ON DELETE CASCADE,
  version         TEXT NOT NULL,
  channel         TEXT NOT NULL
                  CHECK (channel IN ('internal', 'beta', 'stable')),
  released_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_by     UUID,
  changelog       TEXT,            -- markdown; published when channel='stable' AND public_changelog=TRUE
  internal_notes  TEXT,            -- never exposed via /changelog/public
  artifact_url    TEXT,
  commit_sha      TEXT,
  rollback_of     UUID REFERENCES release_history(id),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_release_history_component_released
  ON release_history(component_id, released_at DESC);
CREATE INDEX IF NOT EXISTS idx_release_history_channel
  ON release_history(channel, released_at DESC);

-- Wire the foreign key from release_components.current_release_id back to
-- release_history.id now that release_history exists. Deferred so the two
-- creates can happen in any order during fresh DB rebuilds.
ALTER TABLE release_components
  ADD CONSTRAINT release_components_current_release_fk
  FOREIGN KEY (current_release_id) REFERENCES release_history(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- release_backlog_items — pending work targeting a future release
-- -----------------------------------------------------------------------------
-- Optional `vtid` column links to vtid_ledger.vtid (P1 decision: separate
-- table, optional VTID link). When vtid IS NOT NULL, the API returns
-- vtid_ledger.status as the effective status (read-through) and rejects
-- writes to the local `status` field — see services/gateway/src/routes/releases.ts.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS release_backlog_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id    UUID NOT NULL REFERENCES release_components(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  summary         TEXT,
  vtid            TEXT,            -- optional → vtid_ledger.vtid (P1)
  status          TEXT NOT NULL
                  CHECK (status IN
                    ('proposed', 'planned', 'in_progress', 'blocked', 'done', 'dropped')),
  target_version  TEXT,
  target_channel  TEXT
                  CHECK (target_channel IN ('internal', 'beta', 'stable')),
  visibility      TEXT NOT NULL DEFAULT 'internal'
                  CHECK (visibility IN ('internal', 'tenant', 'public')),
  priority        INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_release_backlog_component_status
  ON release_backlog_items(component_id, status);
CREATE INDEX IF NOT EXISTS idx_release_backlog_vtid
  ON release_backlog_items(vtid)
  WHERE vtid IS NOT NULL;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
-- Service role (gateway via SUPABASE_SERVICE_ROLE) has full access; the
-- gateway enforces role/tenant scoping in application code per spec § 7.
-- -----------------------------------------------------------------------------

ALTER TABLE release_components       ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_history          ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_backlog_items    ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Seed: platform components (4 rows)
-- -----------------------------------------------------------------------------
-- Tenant rows (MAXINA Desktop / iOS / Android) seeded in a separate migration
-- once the canonical tenants.id for MAXINA is confirmed — keeping this
-- migration self-contained.
-- public_changelog defaults per P4: web=true, others=false.
-- -----------------------------------------------------------------------------

INSERT INTO release_components (slug, display_name, owner, surface, public_changelog)
VALUES
  ('platform.command-hub', 'Command Hub',     'platform', 'command_hub', FALSE),
  ('platform.api',         'Gateway / API',   'platform', 'api',         FALSE),
  ('platform.sdk',         'SDK',             'platform', 'sdk',         FALSE),
  ('platform.web',         'vitanaland.com',  'platform', 'web',         TRUE)
ON CONFLICT (slug) DO NOTHING;
