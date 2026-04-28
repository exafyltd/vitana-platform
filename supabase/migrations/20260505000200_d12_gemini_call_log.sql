-- D12 telemetry — gemini_call_log (VTID-DANCE-D12)
-- Per-call log of every Gemini invocation so we can correlate cost
-- (tokens), quality (downstream user actions), and latency (per feature).
-- Built now during the credit window so we have real attribution data
-- when credits expire on 2026-07-01 and we need to make a stay-or-migrate
-- decision.

CREATE TABLE IF NOT EXISTS public.gemini_call_log (
  call_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature          text NOT NULL,                 -- 'classifier' | 'extractor' | 'matchmaker' | 'voice' | 'embedding' | 'pre_compute' | 'counter_questions'
  model            text NOT NULL,                 -- 'gemini-2.5-pro' | 'gemini-2.0-flash' | 'gemini-embedding-001' | 'gemini-live'
  prompt_tokens    int,
  completion_tokens int,
  total_tokens     int,
  latency_ms       int,
  status           text NOT NULL CHECK (status IN ('success','error','fallback','cached')),
  error            text,
  user_id          uuid,                          -- the actor when applicable
  vitana_id        text,                          -- denorm for support querying
  intent_id        uuid,                          -- when call relates to an intent
  match_id         uuid,                          -- when call relates to a match
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gemini_call_log_feature_time_idx
  ON public.gemini_call_log (feature, created_at DESC);
CREATE INDEX IF NOT EXISTS gemini_call_log_model_time_idx
  ON public.gemini_call_log (model, created_at DESC);
CREATE INDEX IF NOT EXISTS gemini_call_log_user_idx
  ON public.gemini_call_log (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gemini_call_log_intent_idx
  ON public.gemini_call_log (intent_id) WHERE intent_id IS NOT NULL;

COMMENT ON TABLE public.gemini_call_log IS
  'D12: per-call telemetry for every Gemini invocation across the gateway. Used to compute cost-per-feature + correlate with user outcomes during the May/June 2026 credit window before the post-credit decision.';

-- A view for quick daily cost-by-feature aggregates.
CREATE OR REPLACE VIEW public.gemini_cost_daily AS
SELECT
  date_trunc('day', created_at)::date AS day,
  feature,
  model,
  count(*) AS calls,
  sum(prompt_tokens) AS prompt_tokens,
  sum(completion_tokens) AS completion_tokens,
  sum(total_tokens) AS total_tokens,
  avg(latency_ms)::int AS avg_latency_ms,
  count(*) FILTER (WHERE status = 'error') AS errors,
  count(*) FILTER (WHERE status = 'fallback') AS fallbacks
FROM public.gemini_call_log
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 4 DESC;

COMMENT ON VIEW public.gemini_cost_daily IS
  'Daily per-feature/model aggregates of Gemini calls. Drives the Command Hub Gemini-cost tile.';
