-- VTID-04754: Jev P0 foundation — persisted spend counters and the shadow
-- decision log (docs/JEV-INTEGRATION-PLAN.md §10).
--
-- jev_spend_counters: one row per tenant x plane x calendar month (UTC). The
--   gateway checks tenant_settings.feature_flags.jev.monthly_budget_usd
--   against the sum of a tenant's rows before every Jev call, and increments
--   the row after every call that cost tokens. Platform-level calls with no
--   tenant (ops/CI telemetry) are counted under the all-zero tenant id.
-- jev_shadow_decisions: every new Jev gate runs in shadow mode first
--   (JEV_<GATE>_MODE=off|shadow|enforce). A row records what Jev said, what
--   the system actually did, and — filled in later — the real outcome, so the
--   agreement rate per gate is measurable before a gate is enforced.
--
-- Both tables are written and read by the gateway's service role only. RLS
-- is on with no policies, so no client can read spend or decisions. Additive
-- only; no existing table or function is touched.

CREATE TABLE IF NOT EXISTS public.jev_spend_counters (
    tenant_id UUID NOT NULL,
    plane TEXT NOT NULL CHECK (plane IN ('internal','partner_org','member','patient','system_autopilot')),
    month DATE NOT NULL,
    calls BIGINT NOT NULL DEFAULT 0,
    input_tokens BIGINT NOT NULL DEFAULT 0,
    cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, plane, month)
);

ALTER TABLE public.jev_spend_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.jev_spend_counters FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.jev_spend_counters TO service_role;

-- Atomic increment; returns the tenant's month total across all planes after
-- the increment so the caller can refresh its budget cache in one round trip.
CREATE OR REPLACE FUNCTION public.jev_record_spend(
    p_tenant_id UUID,
    p_plane TEXT,
    p_input_tokens BIGINT,
    p_cost_usd NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
    v_month DATE := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
    v_total NUMERIC;
BEGIN
    INSERT INTO public.jev_spend_counters AS c (tenant_id, plane, month, calls, input_tokens, cost_usd, updated_at)
    VALUES (p_tenant_id, p_plane, v_month, 1, GREATEST(p_input_tokens, 0), GREATEST(p_cost_usd, 0), now())
    ON CONFLICT (tenant_id, plane, month) DO UPDATE
       SET calls = c.calls + 1,
           input_tokens = c.input_tokens + GREATEST(EXCLUDED.input_tokens, 0),
           cost_usd = c.cost_usd + GREATEST(EXCLUDED.cost_usd, 0),
           updated_at = now();

    SELECT COALESCE(SUM(cost_usd), 0) INTO v_total
      FROM public.jev_spend_counters
     WHERE tenant_id = p_tenant_id AND month = v_month;
    RETURN v_total;
END;
$fn$;
REVOKE ALL ON FUNCTION public.jev_record_spend(UUID, TEXT, BIGINT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jev_record_spend(UUID, TEXT, BIGINT, NUMERIC) TO service_role;

CREATE TABLE IF NOT EXISTS public.jev_shadow_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gate TEXT NOT NULL,
    decision TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('shadow','enforce')),
    plane TEXT NOT NULL CHECK (plane IN ('internal','partner_org','member','patient','system_autopilot')),
    tenant_id UUID,
    subject_type TEXT NOT NULL,
    subject_ref TEXT NOT NULL,
    jev_outcome TEXT NOT NULL CHECK (jev_outcome IN ('decided','abstained','fallback','failed','denied','invalid')),
    jev_verdict JSONB,
    jev_confidence NUMERIC,
    system_action TEXT NOT NULL,
    agreed BOOLEAN,
    outcome TEXT,
    outcome_at TIMESTAMPTZ,
    cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jev_shadow_gate_created ON public.jev_shadow_decisions (gate, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jev_shadow_subject ON public.jev_shadow_decisions (gate, subject_type, subject_ref);

ALTER TABLE public.jev_shadow_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.jev_shadow_decisions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.jev_shadow_decisions TO service_role;

-- Per-gate rollup for the Command Hub Jev card (last N days).
CREATE OR REPLACE FUNCTION public.jev_shadow_gate_stats(p_days INT DEFAULT 14)
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
