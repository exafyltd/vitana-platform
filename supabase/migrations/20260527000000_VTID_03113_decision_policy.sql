-- Phase B.1 (decision-contract refactor) — decision_policy table.
--
-- VTID-03113. Versioned, tenant-aware, time-bounded numeric/enum
-- policy values. One row per (policy_key, tenant_id, version) triple.
-- Replaces hard-coded constants scattered across the renderer,
-- ranker, fusion engine and voice layers (~140 of them, per the
-- May 2026 contextual-intelligence audit).
--
-- Phase B introduces the schema only. No code reads from this table
-- yet — that lands in Phase B.4 (vertical proof on the
-- live-system-instruction.ts greeting block).
--
-- Resolver contract (see services/gateway/src/services/decision-contract/
-- policy-resolver.ts, landing in Phase B.3):
--   For a given (policy_key, tenant_id, now) pick the highest
--   `version` row where:
--     effective_from <= now
--     AND (effective_until IS NULL OR effective_until > now)
--   A tenant-specific row wins over `tenant_id IS NULL`.
--
-- RLS:
--   - service_role bypasses RLS (Supabase default). The resolver
--     runs as service.
--   - authenticated app role: SELECT only, scoped to global defaults
--     (`tenant_id IS NULL`) plus rows for tenants the user belongs
--     to (via user_tenants, same pattern as B0c / B2).
--   - No INSERT/UPDATE/DELETE policy for authenticated → effectively
--     read-only for non-service callers.

CREATE TABLE IF NOT EXISTS decision_policy (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable, dotted, namespaced key. Examples:
  --   session.recency_bucket.reconnect_max_seconds
  --   session.recency_bucket.recent_max_minutes
  -- Exact key strings are owned by `policy-keys.ts` (Phase B.3).
  policy_key      TEXT NOT NULL,
  -- NULL = global default. Non-NULL = tenant-specific override.
  tenant_id       UUID,
  -- Monotonic per (policy_key, tenant_id). Newer versions never
  -- delete older ones — they supersede via effective_from / until.
  version         INTEGER NOT NULL,
  -- The unwrapped value. JSONB so a single column carries numbers,
  -- strings, arrays, or small objects (the resolver returns the
  -- value typed by the caller via generics, never raw JSON).
  value_json      JSONB NOT NULL,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = open-ended (the row is current until a newer version
  -- explicitly closes it, or another non-NULL `effective_until`
  -- expires).
  effective_until TIMESTAMPTZ,
  -- Where the row came from. 'seed' for migrations, other values
  -- reserved for future admin UI / autopilot / experiment writers.
  source          TEXT NOT NULL DEFAULT 'seed'
    CHECK (source IN ('seed', 'admin_ui', 'autopilot', 'experiment')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT,
  UNIQUE (policy_key, tenant_id, version)
);

-- Resolver hot-path query: filter by (policy_key, tenant_id) and
-- pick the most recent row that is currently effective. Ordering
-- `effective_from DESC` puts candidates first.
CREATE INDEX IF NOT EXISTS decision_policy_lookup_idx
  ON decision_policy (policy_key, tenant_id, effective_from DESC);

ALTER TABLE decision_policy ENABLE ROW LEVEL SECURITY;

-- Read-only policy for app callers. Service-role bypasses RLS
-- entirely, so seeds and admin writes work without explicit
-- INSERT/UPDATE/DELETE policies here.
DROP POLICY IF EXISTS decision_policy_tenant_read ON decision_policy;
CREATE POLICY decision_policy_tenant_read
  ON decision_policy
  FOR SELECT
  TO authenticated
  USING (
    tenant_id IS NULL
    OR tenant_id IN (
      SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
    )
  );

COMMENT ON TABLE decision_policy IS
  'Phase B.1 (decision-contract refactor): versioned, tenant-aware, '
  'time-bounded numeric/enum policy values. Resolver picks the highest '
  'version row that is currently effective; tenant-specific wins over '
  'NULL tenant_id. Service-role writes; authenticated reads only.';
