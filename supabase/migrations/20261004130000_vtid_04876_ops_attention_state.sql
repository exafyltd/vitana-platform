-- VTID-04876: Command Hub Overview Phase 1 — hysteresis state for
-- GET /api/v1/ops/attention (plan A, REVISION 3 N2 / REVISION 4 N8).
--
-- One row per (env, fingerprint) for attention candidates whose source has
-- no timestamp of its own (service-health probes, prod/staging commit drift,
-- voice verdicts, supervisor alerts). first_seen is kept while the
-- fingerprint keeps being observed and reset after 90 s unseen; last_seen is
-- the latest observation. Every fingerprint already starts with the env, and
-- env is part of the primary key, so staging and production observations
-- never mix (owner decision 6, 2026-10-04: staging may write env='staging').
--
-- Written and read by the gateway's service role only; RLS on, no client
-- policies. Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.ops_attention_state (
    env TEXT NOT NULL CHECK (env IN ('production', 'staging')),
    fingerprint TEXT NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (env, fingerprint)
);

CREATE INDEX IF NOT EXISTS ops_attention_state_last_seen_idx
    ON public.ops_attention_state (env, last_seen);

ALTER TABLE public.ops_attention_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_attention_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ops_attention_state TO service_role;

COMMENT ON TABLE public.ops_attention_state IS
  'VTID-04876: /ops/attention hysteresis — first/last observation per (env, fingerprint) for sources without their own timestamp. Gateway service role only. Rows unseen for more than a day carry no meaning and may be deleted.';
