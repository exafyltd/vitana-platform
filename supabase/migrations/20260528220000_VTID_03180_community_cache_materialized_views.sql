-- Phase 1 W1 (VTID-03180 CACHE): three materialized views for the
-- heaviest aggregation reads the Cloudflare community-cache worker fronts.
--
-- W1 scope: ship the views to STAGING ONLY via RUN-MIGRATION.yml. Routes
-- continue reading from base tables; W2 swaps reads to the MVs once the
-- worker is observed serving stale-cache hits cleanly.
--
-- Refresh strategy in W1: hourly CONCURRENTLY refresh via a small cron
-- script (added in PR #3 FINETUNES' STAGE-ARTIFACTS-GCS proximity layer
-- if needed; for W1 we leave them populate-once and verify the schema
-- shape works under the worker's cache TTL).
--
-- Hard rule (per CLAUDE.md): introspect information_schema.columns BEFORE
-- writing CREATE TABLE IF NOT EXISTS to avoid the user_journey-style silent
-- no-op hazard. Materialized views are namespaced separately; no collision
-- expected, but CREATE MATERIALIZED VIEW IF NOT EXISTS is still defensive.

-- ===========================================================================
-- mv_autopilot_recs_summary
-- ===========================================================================
-- Pre-aggregates the autopilot recommendations endpoint payload per tenant
-- so the cache can serve a JSON-stable shape. Columns chosen to match the
-- shape services/gateway/src/routes/autopilot.ts currently builds at read
-- time (kind, priority, source_type, count).

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_autopilot_recs_summary AS
SELECT
  tenant_id,
  kind,
  COALESCE(priority, 'normal') AS priority,
  COALESCE(source_type, 'unknown') AS source_type,
  COUNT(*) AS rec_count,
  MAX(created_at) AS latest_created_at
FROM autopilot_recs
WHERE created_at > now() - INTERVAL '30 days'
GROUP BY tenant_id, kind, priority, source_type
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_autopilot_recs_summary_unique_idx
  ON mv_autopilot_recs_summary (tenant_id, kind, priority, source_type);

-- ===========================================================================
-- mv_vitana_index_overview
-- ===========================================================================
-- Latest value per (user_id, axis) for the index overview endpoint. The
-- detail endpoint still reads raw rows; overview is the heavier aggregation
-- that benefits most from caching.

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_vitana_index_overview AS
SELECT DISTINCT ON (user_id, axis)
  user_id,
  axis,
  value,
  computed_at,
  metadata
FROM vitana_index_values
ORDER BY user_id, axis, computed_at DESC
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_vitana_index_overview_unique_idx
  ON mv_vitana_index_overview (user_id, axis);

-- ===========================================================================
-- mv_intent_kind_30d
-- ===========================================================================
-- 30-day intent-kind counts per user for the /intents/board endpoint sidebar.
-- Sourced from oasis_events rather than a base intents table because the
-- intent-creation surface emits the event and the table snapshots latest
-- state only.

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_intent_kind_30d AS
SELECT
  actor_id AS user_id,
  COALESCE(metadata->>'intent_kind', 'unknown') AS intent_kind,
  COUNT(*) AS event_count,
  MAX(created_at) AS latest_at
FROM oasis_events
WHERE topic = 'autopilot.intent.created'
  AND created_at > now() - INTERVAL '30 days'
  AND actor_id IS NOT NULL
GROUP BY actor_id, COALESCE(metadata->>'intent_kind', 'unknown')
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_intent_kind_30d_unique_idx
  ON mv_intent_kind_30d (user_id, intent_kind);

-- Operator note: refresh via
--   REFRESH MATERIALIZED VIEW CONCURRENTLY mv_<name>;
-- Schedule TBD in a small refresh cron added in W2 once endpoint cutover
-- begins. Until then, the worker SWR window absorbs staleness.
