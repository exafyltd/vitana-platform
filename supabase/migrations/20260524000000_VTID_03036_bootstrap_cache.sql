-- VTID-03036: shared bootstrap_cache table for /orb/context-bootstrap.
--
-- Background
-- ==========
-- VTID-03035 added an in-memory per-instance cache for the bootstrap
-- response. It worked for same-instance requests (probe verified
-- `cached: true, age_ms=946`) but the agent worker's HTTP call from
-- us-central1 Cloud Run lands on the gateway's load balancer, which
-- can route to a different gateway instance than the one that handled
-- the token mint. Result: cache miss rate ~50% in production traces;
-- bootstrap_latency_ms stayed at 600-800ms instead of dropping to ~50ms.
--
-- This table moves the cache to a shared store so every gateway instance
-- sees the same warm entries. Token-mint endpoints write here; bootstrap
-- handler reads here when its local in-memory layer misses.
--
-- Schema
-- ======
-- cache_key   : "{user_id}|{agent_id}|{lang}" — matches gateway's
--               bootstrapCacheKey() function.
-- payload     : full /orb/context-bootstrap response body, JSON.
-- expires_at  : NOW() + 60s (mirrors the in-memory TTL).
-- created_at  : audit-only.
--
-- TTL is enforced at read time (WHERE expires_at > NOW()). A periodic
-- vacuum/delete is NOT strictly required — stale rows are harmless and
-- get overwritten on the next mint for the same key. If table growth
-- becomes a concern, add a daily DELETE WHERE expires_at < NOW() job.

CREATE TABLE IF NOT EXISTS bootstrap_cache (
  cache_key   TEXT        PRIMARY KEY,
  payload     JSONB       NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reads filter by `WHERE cache_key = ? AND expires_at > NOW()`. The PK
-- already covers the equality on cache_key; an additional index on
-- expires_at is only useful for the optional cleanup job below.
CREATE INDEX IF NOT EXISTS bootstrap_cache_expires_idx
  ON bootstrap_cache (expires_at);

-- This table is gateway-internal infrastructure; never touched by user
-- workflows. RLS off, accessed only by the service role.
ALTER TABLE bootstrap_cache DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE bootstrap_cache IS
  'VTID-03036 — shared response cache for /orb/context-bootstrap. 60s TTL. ' ||
  'Token-mint endpoints write here; the bootstrap handler reads here after ' ||
  'an in-memory miss to serve cross-instance cache hits in the Cloud Run fleet.';
