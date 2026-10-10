-- VTID-05012 rollback: restore the VTID-04754 shape of jev_shadow_decisions and jev_shadow_gate_stats.
-- Skipped rows only exist because of this change and carry no Jev call; they are deleted first so the
-- original outcome constraint can be restored. Run only after the gateway code that writes them is reverted.
BEGIN;
DELETE FROM public.jev_shadow_decisions WHERE jev_outcome = 'skipped';
DROP INDEX IF EXISTS public.uq_jev_shadow_skip;
ALTER TABLE public.jev_shadow_decisions DROP CONSTRAINT IF EXISTS jev_shadow_decisions_skip_reason_check;
ALTER TABLE public.jev_shadow_decisions DROP CONSTRAINT IF EXISTS jev_shadow_decisions_jev_outcome_check;
ALTER TABLE public.jev_shadow_decisions
    ADD CONSTRAINT jev_shadow_decisions_jev_outcome_check
    CHECK (jev_outcome IN ('decided','abstained','fallback','failed','denied','invalid'));
ALTER TABLE public.jev_shadow_decisions DROP COLUMN IF EXISTS skip_reason, DROP COLUMN IF EXISTS lean_agreed;

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
    cost_usd NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
    SELECT s.gate,
           (array_agg(s.mode ORDER BY s.created_at DESC))[1] AS mode,
           COUNT(*) AS calls,
           COUNT(*) FILTER (WHERE s.jev_outcome = 'decided') AS decided,
           COUNT(*) FILTER (WHERE s.agreed IS NOT NULL) AS with_outcome,
           COUNT(*) FILTER (WHERE s.agreed) AS agreed,
           CASE WHEN COUNT(*) FILTER (WHERE s.agreed IS NOT NULL) = 0 THEN NULL
                ELSE ROUND(COUNT(*) FILTER (WHERE s.agreed)::numeric
                           / COUNT(*) FILTER (WHERE s.agreed IS NOT NULL), 4) END AS agreement_rate,
           COALESCE(SUM(s.cost_usd), 0) AS cost_usd
      FROM public.jev_shadow_decisions s
     WHERE s.created_at >= now() - make_interval(days => GREATEST(p_days, 1))
     GROUP BY s.gate
     ORDER BY s.gate;
$fn$;
REVOKE ALL ON FUNCTION public.jev_shadow_gate_stats(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jev_shadow_gate_stats(INT) TO service_role;
COMMIT;
