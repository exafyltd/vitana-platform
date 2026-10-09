-- VTID-05012: Jev self-healing observability.
--
-- 1. A gate that is on (shadow/enforce) but ends without asking Jev (no evidence, an error) now
--    writes a $0 'skipped' row with a reason, so a skip no longer looks like a gate that never ran.
--    One row per (gate, subject_ref, skip_reason): the partial unique index makes a repeat a no-op.
-- 2. lean_agreed: for an abstained row, whether Jev's below-threshold answer matched the real
--    outcome. `agreed` keeps its meaning (decided rows only), so existing agreement rates are
--    unchanged.
-- 3. jev_shadow_gate_stats gains skipped, last_row_at, lean_compared, lean_agreed. `calls` now
--    counts Jev calls only (skipped rows excluded), which is what it counted before skips existed.
-- Idempotent.

ALTER TABLE public.jev_shadow_decisions
    ADD COLUMN IF NOT EXISTS skip_reason TEXT,
    ADD COLUMN IF NOT EXISTS lean_agreed BOOLEAN;

ALTER TABLE public.jev_shadow_decisions DROP CONSTRAINT IF EXISTS jev_shadow_decisions_jev_outcome_check;
ALTER TABLE public.jev_shadow_decisions
    ADD CONSTRAINT jev_shadow_decisions_jev_outcome_check
    CHECK (jev_outcome IN ('decided','abstained','fallback','failed','denied','invalid','skipped'));

ALTER TABLE public.jev_shadow_decisions DROP CONSTRAINT IF EXISTS jev_shadow_decisions_skip_reason_check;
ALTER TABLE public.jev_shadow_decisions
    ADD CONSTRAINT jev_shadow_decisions_skip_reason_check
    CHECK ((jev_outcome = 'skipped') = (skip_reason IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS uq_jev_shadow_skip
    ON public.jev_shadow_decisions (gate, subject_ref, skip_reason)
    WHERE jev_outcome = 'skipped';

DROP FUNCTION IF EXISTS public.jev_shadow_gate_stats(INT);
CREATE FUNCTION public.jev_shadow_gate_stats(p_days INT DEFAULT 14)
RETURNS TABLE (
    gate TEXT,
    mode TEXT,
    calls BIGINT,
    decided BIGINT,
    with_outcome BIGINT,
    agreed BIGINT,
    agreement_rate NUMERIC,
    cost_usd NUMERIC,
    skipped BIGINT,
    last_row_at TIMESTAMPTZ,
    lean_compared BIGINT,
    lean_agreed BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
    SELECT s.gate,
           (array_agg(s.mode ORDER BY s.created_at DESC))[1] AS mode,
           COUNT(*) FILTER (WHERE s.jev_outcome <> 'skipped') AS calls,
           COUNT(*) FILTER (WHERE s.jev_outcome = 'decided') AS decided,
           COUNT(*) FILTER (WHERE s.agreed IS NOT NULL) AS with_outcome,
           COUNT(*) FILTER (WHERE s.agreed) AS agreed,
           CASE WHEN COUNT(*) FILTER (WHERE s.agreed IS NOT NULL) = 0 THEN NULL
                ELSE ROUND(COUNT(*) FILTER (WHERE s.agreed)::numeric
                           / COUNT(*) FILTER (WHERE s.agreed IS NOT NULL), 4) END AS agreement_rate,
           COALESCE(SUM(s.cost_usd), 0) AS cost_usd,
           COUNT(*) FILTER (WHERE s.jev_outcome = 'skipped') AS skipped,
           MAX(s.created_at) AS last_row_at,
           COUNT(*) FILTER (WHERE s.lean_agreed IS NOT NULL) AS lean_compared,
           COUNT(*) FILTER (WHERE s.lean_agreed) AS lean_agreed
      FROM public.jev_shadow_decisions s
     WHERE s.created_at >= now() - make_interval(days => GREATEST(p_days, 1))
     GROUP BY s.gate
     ORDER BY s.gate;
$fn$;
REVOKE ALL ON FUNCTION public.jev_shadow_gate_stats(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jev_shadow_gate_stats(INT) TO service_role;
