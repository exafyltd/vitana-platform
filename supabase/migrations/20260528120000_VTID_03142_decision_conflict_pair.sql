-- Phase D42 (decision-contract refactor) — decision_conflict_pair table.
--
-- VTID-03142. Externalizes the `CONFLICT_TYPE_MAP` constant in
-- `services/gateway/src/services/d42-context-fusion-engine.ts` (6
-- conflict types covering 9 (domain_a, domain_b) pairs) into a
-- dedicated relational table — per user directive, this is NOT a
-- JSONB array on decision_policy. The audit trail wants one row per
-- (conflict_type, domain pair) tuple so an analyst can grep
-- `decision_conflict_pair` and see exactly which domain pairs the
-- fusion engine treats as conflicting.
--
-- Schema mirrors decision_policy conventions: versioned, tenant-aware,
-- effective_from / effective_until, service-role writes + authenticated
-- reads. RLS pattern matches `decision_policy`.

CREATE TABLE IF NOT EXISTS decision_conflict_pair (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The conflict-type bucket the pair belongs to. Stable string used
  -- as the key in the fusion engine's `CONFLICT_TYPE_MAP`. Examples:
  --   health_vs_monetization
  --   boundaries_vs_optimization
  conflict_type   TEXT NOT NULL,
  -- Domain pair, ordered alphabetically so (a,b) and (b,a) collapse
  -- to the same row at write time (enforced by app + seeds — there is
  -- no DB-level ordering check because PriorityDomain values are
  -- stable enums managed in TS).
  domain_a        TEXT NOT NULL,
  domain_b        TEXT NOT NULL,
  -- NULL = global default. Non-NULL = tenant-specific override.
  tenant_id       UUID,
  -- Monotonic per (conflict_type, domain_a, domain_b, tenant_id).
  version         INTEGER NOT NULL DEFAULT 1,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_until TIMESTAMPTZ,
  source          TEXT NOT NULL DEFAULT 'seed'
    CHECK (source IN ('seed', 'admin_ui', 'autopilot', 'experiment')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT,
  UNIQUE (conflict_type, domain_a, domain_b, tenant_id, version)
);

-- Hot-path query: read all currently-effective rows for a (tenant_id)
-- and group by conflict_type. The accessor caches the result for 15s.
CREATE INDEX IF NOT EXISTS decision_conflict_pair_lookup_idx
  ON decision_conflict_pair (tenant_id, conflict_type, effective_from DESC);

ALTER TABLE decision_conflict_pair ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS decision_conflict_pair_tenant_read ON decision_conflict_pair;
CREATE POLICY decision_conflict_pair_tenant_read
  ON decision_conflict_pair
  FOR SELECT
  TO authenticated
  USING (
    tenant_id IS NULL
    OR tenant_id IN (
      SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
    )
  );

COMMENT ON TABLE decision_conflict_pair IS
  'Phase D42 (decision-contract refactor): per-conflict-type domain '
  'pair map for the fusion engine. One row per (conflict_type, '
  'domain_a, domain_b) tuple. Dedicated table (not JSONB array) so '
  'analysts can grep + diff conflict rules over time. Service-role '
  'writes; authenticated reads only.';

-- =========================================================================
-- Seed rows — byte-identical to CONFLICT_TYPE_MAP in
-- d42-context-fusion-engine.ts:76-89. Idempotent (WHERE NOT EXISTS).
-- =========================================================================

-- 1. health_vs_monetization → 1 pair
INSERT INTO decision_conflict_pair (conflict_type, domain_a, domain_b, tenant_id, version, source, notes)
SELECT 'health_vs_monetization', 'commerce_monetization', 'health_wellbeing', NULL, 1, 'seed',
       'd42-context-fusion-engine.ts:77'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_conflict_pair
  WHERE conflict_type='health_vs_monetization'
    AND domain_a='commerce_monetization' AND domain_b='health_wellbeing'
    AND tenant_id IS NULL AND version=1
);

-- 2. rest_vs_social → 1 pair
INSERT INTO decision_conflict_pair (conflict_type, domain_a, domain_b, tenant_id, version, source, notes)
SELECT 'rest_vs_social', 'health_wellbeing', 'social_relationships', NULL, 1, 'seed',
       'd42-context-fusion-engine.ts:78'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_conflict_pair
  WHERE conflict_type='rest_vs_social'
    AND domain_a='health_wellbeing' AND domain_b='social_relationships'
    AND tenant_id IS NULL AND version=1
);

-- 3. learning_vs_availability → 1 pair
INSERT INTO decision_conflict_pair (conflict_type, domain_a, domain_b, tenant_id, version, source, notes)
SELECT 'learning_vs_availability', 'health_wellbeing', 'learning_growth', NULL, 1, 'seed',
       'd42-context-fusion-engine.ts:79'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_conflict_pair
  WHERE conflict_type='learning_vs_availability'
    AND domain_a='health_wellbeing' AND domain_b='learning_growth'
    AND tenant_id IS NULL AND version=1
);

-- 4. goals_vs_desire → 1 pair
INSERT INTO decision_conflict_pair (conflict_type, domain_a, domain_b, tenant_id, version, source, notes)
SELECT 'goals_vs_desire', 'exploration_discovery', 'learning_growth', NULL, 1, 'seed',
       'd42-context-fusion-engine.ts:80'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_conflict_pair
  WHERE conflict_type='goals_vs_desire'
    AND domain_a='exploration_discovery' AND domain_b='learning_growth'
    AND tenant_id IS NULL AND version=1
);

-- 5. boundaries_vs_optimization → 2 pairs
INSERT INTO decision_conflict_pair (conflict_type, domain_a, domain_b, tenant_id, version, source, notes)
SELECT 'boundaries_vs_optimization', 'commerce_monetization', 'health_wellbeing', NULL, 1, 'seed',
       'd42-context-fusion-engine.ts:82'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_conflict_pair
  WHERE conflict_type='boundaries_vs_optimization'
    AND domain_a='commerce_monetization' AND domain_b='health_wellbeing'
    AND tenant_id IS NULL AND version=1
);

INSERT INTO decision_conflict_pair (conflict_type, domain_a, domain_b, tenant_id, version, source, notes)
SELECT 'boundaries_vs_optimization', 'commerce_monetization', 'social_relationships', NULL, 1, 'seed',
       'd42-context-fusion-engine.ts:83'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_conflict_pair
  WHERE conflict_type='boundaries_vs_optimization'
    AND domain_a='commerce_monetization' AND domain_b='social_relationships'
    AND tenant_id IS NULL AND version=1
);

-- 6. capacity_vs_demand → 2 pairs
INSERT INTO decision_conflict_pair (conflict_type, domain_a, domain_b, tenant_id, version, source, notes)
SELECT 'capacity_vs_demand', 'health_wellbeing', 'learning_growth', NULL, 1, 'seed',
       'd42-context-fusion-engine.ts:86'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_conflict_pair
  WHERE conflict_type='capacity_vs_demand'
    AND domain_a='health_wellbeing' AND domain_b='learning_growth'
    AND tenant_id IS NULL AND version=1
);

INSERT INTO decision_conflict_pair (conflict_type, domain_a, domain_b, tenant_id, version, source, notes)
SELECT 'capacity_vs_demand', 'health_wellbeing', 'social_relationships', NULL, 1, 'seed',
       'd42-context-fusion-engine.ts:87'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_conflict_pair
  WHERE conflict_type='capacity_vs_demand'
    AND domain_a='health_wellbeing' AND domain_b='social_relationships'
    AND tenant_id IS NULL AND version=1
);
