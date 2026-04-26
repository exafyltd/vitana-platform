-- VTID-01966 — Memory Audit Log (HIPAA-grade dedicated audit table)
--
-- Phase 2 of the memory rebuild plan. Today some memory writes emit OASIS
-- events but READS do not — leaving the HIPAA audit trail incomplete.
-- This migration adds memory_audit_log (separate from oasis_events) so:
--   1. Every memory read AND write is captured with full provenance.
--   2. HIPAA replay queries (give me everything user X accessed in date
--      range Y) are O(index) instead of O(table scan on oasis_events).
--   3. The append-only audit table is partitioned by month so we can
--      drop old partitions cheaply for retention compliance.
--
-- Plan: /home/dstev/.claude/plans/the-vitana-system-has-wild-puffin.md
--       Part 7 Schema (memory_audit_log) + Part 8 Phase 2.

BEGIN;

-- ============================================================================
-- 1. Parent table — partitioned by RANGE(created_at), monthly partitions.
--    All writes go through the parent; Postgres routes to the right partition.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.memory_audit_log (
  id              uuid          NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       text          NOT NULL,
  user_id         uuid          NOT NULL,
  op              text          NOT NULL CHECK (op IN ('read','write','delete','consolidate')),
  tier            text          NOT NULL,           -- 'tier0','tier1','tier2','tier3','identity-lock', etc.
  actor_id        text          NOT NULL,           -- e.g. 'orb-live', 'cognee-extractor', 'user_via_settings_ui'
  source_engine   text,                              -- which engine (closes OASIS provenance gap)
  confidence      real,                              -- 0..1; null for ops where it doesn't apply
  source_event_id text,                              -- upstream OASIS event id, if applicable
  policy_version  text          NOT NULL,           -- e.g. 'mem-2026.04'
  health_scope    boolean       NOT NULL DEFAULT false,  -- HIPAA classification flag
  identity_scope  boolean       NOT NULL DEFAULT false,  -- write to identity-locked fact?
  details         jsonb         NOT NULL DEFAULT '{}',   -- intent, fact_keys hit, latency, etc.
  created_at      timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE public.memory_audit_log IS
  'VTID-01966: HIPAA-grade dedicated audit trail for every memory read/write. Append-only. Partitioned by month — drop old partitions for retention compliance. Distinct from oasis_events (which captures system-wide events; this one captures memory-specific operations with rich detail).';

COMMENT ON COLUMN public.memory_audit_log.tier IS 'Storage tier: tier0 (Redis), tier1 (FAISS), tier2 (pgvector), tier3 (Anthropic Memory Tool), identity-lock, write_fact_rpc, etc.';
COMMENT ON COLUMN public.memory_audit_log.actor_id IS 'Who/what performed the operation. user/system/agent identifiers; correlates with provenance_source.';
COMMENT ON COLUMN public.memory_audit_log.source_engine IS 'Which engine produced this row (orb-live, conversation-client, cognee-extractor, autopilot, brain, etc.).';
COMMENT ON COLUMN public.memory_audit_log.policy_version IS 'Memory governance policy version at audit time (e.g. mem-2026.04). Required for forward-compatible HIPAA audit.';
COMMENT ON COLUMN public.memory_audit_log.health_scope IS 'TRUE if the operation touched health-classified data; gates HIPAA replay reports.';
COMMENT ON COLUMN public.memory_audit_log.identity_scope IS 'TRUE if the operation touched an identity-locked fact_key (Maria → Kemal class).';
COMMENT ON COLUMN public.memory_audit_log.details IS 'Free-form JSONB: query_preview, intent, fact_keys, latency_ms, blocks_returned, error_message, etc.';


-- ============================================================================
-- 2. Static partitions covering 2026-04 → 2027-04 (13 months).
--    A follow-up partition-rotation cron (or pg_partman) handles 2027-05+.
--    Static partitions are the simplest path that's safe for prod today.
-- ============================================================================

DO $$
DECLARE
  yr int;
  mo int;
  start_date date;
  end_date   date;
  part_name  text;
BEGIN
  FOR i IN 0..12 LOOP
    start_date := make_date(2026, 4, 1) + (i || ' months')::interval;
    end_date   := start_date + interval '1 month';
    yr := extract(year FROM start_date)::int;
    mo := extract(month FROM start_date)::int;
    part_name := format('memory_audit_log_y%sm%s', yr, lpad(mo::text, 2, '0'));

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.memory_audit_log FOR VALUES FROM (%L) TO (%L);',
      part_name, start_date, end_date
    );
  END LOOP;
END $$;


-- ============================================================================
-- 3. Indexes for HIPAA replay + dashboards.
--    Created on the parent so they propagate to every partition.
-- ============================================================================

CREATE INDEX IF NOT EXISTS memory_audit_log_user_recency
  ON public.memory_audit_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS memory_audit_log_tenant_recency
  ON public.memory_audit_log (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS memory_audit_log_health_scope
  ON public.memory_audit_log (tenant_id, user_id, created_at DESC)
  WHERE health_scope = true;

CREATE INDEX IF NOT EXISTS memory_audit_log_identity_scope
  ON public.memory_audit_log (tenant_id, user_id, created_at DESC)
  WHERE identity_scope = true;

CREATE INDEX IF NOT EXISTS memory_audit_log_op_tier_recency
  ON public.memory_audit_log (op, tier, created_at DESC);


-- ============================================================================
-- 4. RLS — service-role only. The audit table is internal; users never read
--    their own audit log via RLS. HIPAA replay queries run as service_role
--    via gateway audit endpoints (separate VTID for the read API).
-- ============================================================================

ALTER TABLE public.memory_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_audit_log_service_role_all ON public.memory_audit_log;
CREATE POLICY memory_audit_log_service_role_all
  ON public.memory_audit_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ============================================================================
-- 5. Insert helper RPC — single entry-point used by gateway memory-audit.ts.
--    SECURITY DEFINER so the gateway can use the anon key path if it wants
--    (today it uses service_role directly; this is forward-compatible).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.memory_audit_log_insert(
  p_tenant_id       text,
  p_user_id         uuid,
  p_op              text,
  p_tier            text,
  p_actor_id        text,
  p_policy_version  text,
  p_source_engine   text DEFAULT NULL,
  p_confidence      real DEFAULT NULL,
  p_source_event_id text DEFAULT NULL,
  p_health_scope    boolean DEFAULT false,
  p_identity_scope  boolean DEFAULT false,
  p_details         jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.memory_audit_log (
    id, tenant_id, user_id, op, tier, actor_id, source_engine,
    confidence, source_event_id, policy_version, health_scope,
    identity_scope, details, created_at
  ) VALUES (
    v_id, p_tenant_id, p_user_id, p_op, p_tier, p_actor_id, p_source_engine,
    p_confidence, p_source_event_id, p_policy_version, COALESCE(p_health_scope, false),
    COALESCE(p_identity_scope, false), COALESCE(p_details, '{}'::jsonb), now()
  );
  RETURN v_id;
END $$;

COMMENT ON FUNCTION public.memory_audit_log_insert IS
  'VTID-01966: Single-entry insert helper for memory_audit_log. Used by gateway memory-audit.ts auditMemoryRead/Write. SECURITY DEFINER for forward compatibility.';

GRANT EXECUTE ON FUNCTION public.memory_audit_log_insert TO service_role;


COMMIT;

-- =====================================================================
-- VERIFICATION (run after migration applies):
--
-- A) Parent + partitions exist:
--    SELECT relname FROM pg_class
--      WHERE relname LIKE 'memory_audit_log%'
--      ORDER BY relname;
--    -- Expected: parent + 13 monthly partitions (y2026m04 through y2027m04).
--
-- B) Insert via RPC:
--    SELECT public.memory_audit_log_insert(
--      'test-tenant', gen_random_uuid(), 'read', 'tier0',
--      'orb-live', 'mem-2026.04', 'orb-live', 1.0,
--      NULL, false, false, '{"intent":"recall_recent"}'::jsonb
--    );
--    SELECT count(*) FROM memory_audit_log WHERE actor_id='orb-live';
--
-- C) Confirm partition routing:
--    EXPLAIN INSERT INTO memory_audit_log (tenant_id, user_id, op, tier,
--      actor_id, policy_version) VALUES ('t','...uuid...','write','tier2','x','v');
--    -- Should show "Insert on memory_audit_log_y2026m04" (current partition).
-- =====================================================================
