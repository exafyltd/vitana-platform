-- VTID-03599: LLM call usage visibility in Command Hub
--
-- Direct follow-up to VTID-03579/03563: routing tables and per-call telemetry
-- events already existed, but nothing ever AGGREGATED them. The only way to
-- answer "how many LLM calls did we make today, and who made them" was to
-- read raw `oasis_events` rows one at a time (`queryLLMTelemetry()` does a
-- paginated PostgREST fetch + JS-side filtering, no SQL aggregation) — which
-- is exactly how a 268-call-in-14-days credit-balance leak and a 990-call
-- runaway planner loop both went unnoticed until someone looked at a bill.
--
-- This RPC answers "how many, by whom, on what, and is anything calling a
-- forbidden provider" in one query, cheap enough to poll from the Command
-- Hub on a timer. `non_bedrock_google_or_anthropic_calls` is a deliberate
-- named field, not something the caller has to derive from `by_provider` --
-- it is the exact number that should be zero, so it can be red-flagged in
-- the UI without the frontend knowing the provider enum at all.
--
-- Transport: PostgREST/service_role RPC, not psql — psql from GitHub Actions
-- is structurally broken here (Supabase network allow-list excludes runner
-- IPs, VTID-03485/03492), and this also needs to be callable from the
-- gateway's own PostgREST client without a DB connection string.
CREATE OR REPLACE FUNCTION public.llm_telemetry_summary(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
STABLE
AS $$
  WITH bounded AS (
    SELECT LEAST(GREATEST(coalesce(p_hours, 24), 1), 24 * 30) AS hours
  ),
  window_events AS (
    SELECT
      e.topic,
      coalesce(e.metadata->>'provider', 'unknown') AS provider,
      coalesce(e.metadata->>'service', 'unknown') AS service,
      coalesce(e.metadata->>'stage', 'unknown') AS stage,
      coalesce((e.metadata->>'fallback_used')::boolean, false) AS fallback_used,
      nullif(e.metadata->>'cost_estimate_usd', '')::numeric AS cost_estimate_usd,
      e.created_at
    FROM oasis_events e, bounded b
    WHERE e.topic IN ('llm.call.started', 'llm.call.completed', 'llm.call.failed')
      AND e.created_at > now() - (b.hours || ' hours')::interval
  ),
  totals AS (
    SELECT
      count(*) FILTER (WHERE topic = 'llm.call.started') AS total_started,
      count(*) FILTER (WHERE topic = 'llm.call.completed') AS total_completed,
      count(*) FILTER (WHERE topic = 'llm.call.failed') AS total_failed,
      count(*) FILTER (WHERE topic = 'llm.call.completed' AND fallback_used) AS total_fallback,
      coalesce(sum(cost_estimate_usd) FILTER (WHERE topic = 'llm.call.completed'), 0) AS total_cost_usd,
      -- ALWAYS 10a/10b (VTID-03563): every Claude stage must route via
      -- 'bedrock'; 'anthropic' has no credit balance and 400s every call;
      -- 'vertex' is the Google line this whole workstream exists to kill.
      -- Neither should ever be non-zero again.
      count(*) FILTER (WHERE topic = 'llm.call.started' AND provider IN ('vertex', 'anthropic')) AS non_bedrock_google_or_anthropic_calls
    FROM window_events
  ),
  by_provider AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'provider', provider, 'calls', n, 'completed', completed, 'failed', failed,
      'fallback', fb, 'cost_usd', cost
    ) ORDER BY n DESC), '[]'::jsonb) AS v
    FROM (
      SELECT provider,
        count(*) FILTER (WHERE topic = 'llm.call.started') AS n,
        count(*) FILTER (WHERE topic = 'llm.call.completed') AS completed,
        count(*) FILTER (WHERE topic = 'llm.call.failed') AS failed,
        count(*) FILTER (WHERE topic = 'llm.call.completed' AND fallback_used) AS fb,
        coalesce(sum(cost_estimate_usd) FILTER (WHERE topic = 'llm.call.completed'), 0) AS cost
      FROM window_events
      GROUP BY provider
    ) p
  ),
  by_service AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'service', service, 'calls', n, 'failed', failed
    ) ORDER BY n DESC), '[]'::jsonb) AS v
    FROM (
      SELECT service,
        count(*) FILTER (WHERE topic = 'llm.call.started') AS n,
        count(*) FILTER (WHERE topic = 'llm.call.failed') AS failed
      FROM window_events
      GROUP BY service
    ) s
  ),
  by_stage AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'stage', stage, 'calls', n, 'failed', failed
    ) ORDER BY n DESC), '[]'::jsonb) AS v
    FROM (
      SELECT stage,
        count(*) FILTER (WHERE topic = 'llm.call.started') AS n,
        count(*) FILTER (WHERE topic = 'llm.call.failed') AS failed
      FROM window_events
      GROUP BY stage
    ) st
  ),
  hourly AS (
    -- Flat (hour, provider, calls) rows rather than a nested structure — the
    -- shape that would have made the VTID-03579 planner-loop spike (990
    -- calls/day, most in a handful of hours) visible on a chart instead of
    -- discoverable only by reading a billing CSV after the fact.
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'hour', hr, 'provider', provider, 'calls', n
    ) ORDER BY hr, provider), '[]'::jsonb) AS v
    FROM (
      SELECT date_trunc('hour', created_at) AS hr, provider,
        count(*) FILTER (WHERE topic = 'llm.call.started') AS n
      FROM window_events
      GROUP BY 1, 2
      HAVING count(*) FILTER (WHERE topic = 'llm.call.started') > 0
    ) h
  )
  SELECT jsonb_build_object(
    'window_hours', b.hours,
    'since', now() - (b.hours || ' hours')::interval,
    'generated_at', now(),
    'total_started', t.total_started,
    'total_completed', t.total_completed,
    'total_failed', t.total_failed,
    'total_fallback', t.total_fallback,
    'total_cost_usd', t.total_cost_usd,
    'non_bedrock_google_or_anthropic_calls', t.non_bedrock_google_or_anthropic_calls,
    'by_provider', bp.v,
    'by_service', bs.v,
    'by_stage', bst.v,
    'hourly', h.v
  )
  FROM bounded b, totals t, by_provider bp, by_service bs, by_stage bst, hourly h;
$$;

REVOKE ALL ON FUNCTION public.llm_telemetry_summary(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.llm_telemetry_summary(integer) FROM anon;
REVOKE ALL ON FUNCTION public.llm_telemetry_summary(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.llm_telemetry_summary(integer) TO service_role;

COMMENT ON FUNCTION public.llm_telemetry_summary(integer) IS
  'VTID-03599: aggregates oasis_events llm.call.* topics over a bounded time '
  'window (default/max clamped 1h-720h) into totals, per-provider/service/stage '
  'breakdowns, an hourly trend, and a named non_bedrock_google_or_anthropic_calls '
  'watchdog count. Backs GET /api/v1/llm/telemetry/summary in the Command Hub. '
  'service_role only -- called from the gateway over PostgREST, never from a '
  'browser session.';
