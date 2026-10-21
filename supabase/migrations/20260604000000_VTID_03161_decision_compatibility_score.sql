-- Phase D39 PR 5a (decision-contract refactor) — decision_compatibility_score
-- schema.
--
-- VTID-03161. First slice of the D39 taste-alignment externalization.
-- This migration creates the storage table only. Seeds (138 cells across
-- 9 dimensions) land in PR 5b. No code consumer reads from this table
-- until PR 5c (resolver). PR 5d-g migrate the D39 service to read here.
--
-- Why a dedicated relational table (not JSONB on decision_policy):
--   D39's 9 alignment dimensions are per-(profile_value, candidate_value)
--   compatibility grids — 138 cells total. JSONB would compress the
--   audit trail; a row per cell lets an analyst:
--     SELECT * FROM decision_compatibility_score WHERE dimension='aesthetic'
--   and see exactly which 36 cells the engine uses. A future admin UI
--   can also tune one cell without rewriting a JSONB blob.
--
-- Mirrors the decision_policy / decision_conflict_pair pattern:
--   - versioned, tenant-aware, time-bounded
--   - service-role writes, authenticated SELECT
--   - tenant_id IS NULL = global default; tenant rows override per
--     (dimension, profile_value, candidate_value) when the resolver
--     lands in PR 5c
--
-- Uniqueness — Postgres-safe global-tenant handling:
--   A plain `UNIQUE (..., tenant_id, version)` would treat each NULL
--   tenant_id as distinct in the index, allowing duplicate global
--   default rows. PR 5a uses `NULLS NOT DISTINCT` so two rows with
--   tenant_id IS NULL collide on the unique constraint just like
--   two rows with the same UUID would. Requires Postgres 15+, which
--   Supabase has been on since 2023.

CREATE TABLE IF NOT EXISTS decision_compatibility_score (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Dimension id matching the D39 axis names: 'simplicity', 'premium',
  -- 'aesthetic', 'tone', 'routine', 'social', 'convenience',
  -- 'experience', 'novelty'. Free-text (no enum) so future axes can
  -- be added without DDL — the resolver will reject unknown dims at
  -- runtime via the typed accessor signature.
  dimension       TEXT NOT NULL,
  -- The user's profile value on this dimension (e.g. 'minimalist',
  -- 'value_focused', 'modern'). Free-text; the resolver maps these
  -- to TasteProfile / LifestyleProfile zod enums.
  profile_value   TEXT NOT NULL,
  -- The candidate action's value on this dimension (e.g. 'simple',
  -- 'budget', 'classic'). Free-text; the resolver maps these to
  -- ActionToScore attribute enums.
  candidate_value TEXT NOT NULL,
  -- The compatibility score: 1.0 perfect match, 0.7 compatible,
  -- 0.5 neutral, 0.3 mismatch, 0.2 strong-mismatch (per the
  -- pre-D39 inline maps). NUMERIC(3,2) gives two-decimal precision
  -- in [0, 1] which is the only range the engine emits.
  score           NUMERIC(3,2) NOT NULL CHECK (score >= 0 AND score <= 1),
  -- Optional human-readable note on why this cell carries this
  -- score. Surfaced to analysts in the audit UI.
  rationale       TEXT,
  -- NULL = global default. Non-NULL = tenant-specific override.
  tenant_id       UUID,
  -- Monotonic per (dimension, profile_value, candidate_value,
  -- tenant_id). Older versions never delete — they supersede via
  -- effective_from / effective_until.
  version         INTEGER NOT NULL DEFAULT 1,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_until TIMESTAMPTZ,
  source          TEXT NOT NULL DEFAULT 'seed'
    CHECK (source IN ('seed', 'admin_ui', 'autopilot', 'experiment')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT,
  -- NULLS NOT DISTINCT (PG15+) so the global default rows
  -- (tenant_id IS NULL) collide on the unique constraint like
  -- any tenant-specific rows would. Without this, the index treats
  -- each NULL tenant as distinct and admits duplicate global rows.
  UNIQUE NULLS NOT DISTINCT
    (dimension, profile_value, candidate_value, tenant_id, version)
);

-- Hot-path: the resolver looks up by (dimension, tenant_id,
-- profile_value) and picks the most recently effective candidate
-- list. Ordering effective_from DESC puts candidates first.
CREATE INDEX IF NOT EXISTS decision_compatibility_score_lookup_idx
  ON decision_compatibility_score (
    dimension, tenant_id, profile_value, effective_from DESC
  );

ALTER TABLE decision_compatibility_score ENABLE ROW LEVEL SECURITY;

-- Authenticated app role: SELECT only, scoped to global defaults
-- (tenant_id IS NULL) plus rows for the caller's tenants. Service-
-- role bypasses RLS so seeds + admin writes work without an explicit
-- INSERT/UPDATE/DELETE policy here. Same posture as decision_policy
-- and decision_conflict_pair.
DROP POLICY IF EXISTS decision_compatibility_score_tenant_read
  ON decision_compatibility_score;
CREATE POLICY decision_compatibility_score_tenant_read
  ON decision_compatibility_score
  FOR SELECT
  TO authenticated
  USING (
    tenant_id IS NULL
    OR tenant_id IN (
      SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
    )
  );

COMMENT ON TABLE decision_compatibility_score IS
  'Phase D39 (decision-contract refactor): per-(dimension, profile, '
  'candidate) compatibility scores for taste / lifestyle alignment. '
  'One row per cell; the resolver in PR 5c will look up scores by '
  '(dimension, profile_value, candidate_value, tenant_id). '
  'Service-role writes; authenticated reads only.';
