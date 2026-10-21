-- Phase B.1 (decision-contract refactor) — policy_render_block table.
--
-- VTID-03113. Versioned, tenant-aware, localized prompt fragments.
-- Sibling table to decision_policy: where decision_policy carries
-- numbers / enums / small JSON values, policy_render_block carries
-- the rendered text the model echoes or the renderer concatenates
-- verbatim (e.g. greeting lines, instruction blocks).
--
-- Phase B introduces the schema only. No code reads from this table
-- yet — that lands in Phase B.4 (vertical proof on the
-- live-system-instruction.ts greeting block, 8 buckets × 8 languages).
--
-- Resolver contract (see services/gateway/src/services/decision-contract/
-- policy-resolver.ts, landing in Phase B.3):
--   For a given (block_key, language, tenant_id, now) pick the
--   highest `version` row where:
--     effective_from <= now
--     AND (effective_until IS NULL OR effective_until > now)
--   A tenant-specific row wins over `tenant_id IS NULL`.
--
-- RLS: same shape as decision_policy. Service-role bypass for writes,
-- authenticated SELECT scoped to global defaults plus the user's own
-- tenants.

CREATE TABLE IF NOT EXISTS policy_render_block (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable, dotted, namespaced key (e.g. `greeting.bucket.today`).
  -- Exact key strings are owned by `policy-keys.ts` (Phase B.3).
  block_key       TEXT NOT NULL,
  -- BCP-47-ish short code. Allowed values match SUPPORTED_LANGUAGES
  -- in services/gateway/src/services/decision-contract/types.ts at
  -- the time Phase B.1 lands: en, de, fr, es, ar, zh, ru, sr.
  -- Stored as TEXT (no enum) so adding a language in a future phase
  -- is a seed change, not a schema change.
  language        TEXT NOT NULL,
  -- NULL = global default. Non-NULL = tenant-specific override.
  tenant_id       UUID,
  version         INTEGER NOT NULL,
  -- The rendered fragment, single-line or multi-line. Seeded
  -- verbatim from the current source-of-truth in
  -- live-system-instruction.ts during Phase B.2.
  content         TEXT NOT NULL,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_until TIMESTAMPTZ,
  source          TEXT NOT NULL DEFAULT 'seed'
    CHECK (source IN ('seed', 'admin_ui', 'autopilot', 'experiment')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT,
  UNIQUE (block_key, language, tenant_id, version)
);

CREATE INDEX IF NOT EXISTS policy_render_block_lookup_idx
  ON policy_render_block (block_key, language, tenant_id, effective_from DESC);

ALTER TABLE policy_render_block ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS policy_render_block_tenant_read ON policy_render_block;
CREATE POLICY policy_render_block_tenant_read
  ON policy_render_block
  FOR SELECT
  TO authenticated
  USING (
    tenant_id IS NULL
    OR tenant_id IN (
      SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
    )
  );

COMMENT ON TABLE policy_render_block IS
  'Phase B.1 (decision-contract refactor): versioned, tenant-aware, '
  'localized prompt fragments. Sibling of decision_policy; carries '
  'verbatim text the renderer concatenates or the model echoes. '
  'Service-role writes; authenticated reads only.';
