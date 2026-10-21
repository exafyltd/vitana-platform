-- VTID-01959: Voice Self-Healing dedupe table (PR #2)
--
-- 5-tuple primary key collapses simultaneous voice OASIS error events from
-- multiple gateway instances + sessions + tenants into one self-healing
-- dispatch per (class, normalized_signature) per gateway_revision per
-- tenant_scope per hour bucket. INSERT ON CONFLICT DO NOTHING at the
-- adapter is the dedupe primitive.
--
-- Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md (PR #2 of 9
-- in the autonomous ORB voice self-healing loop).

CREATE TABLE IF NOT EXISTS public.voice_healing_dedupe (
  class                 TEXT        NOT NULL,
  normalized_signature  TEXT        NOT NULL,
  gateway_revision      TEXT        NOT NULL,
  tenant_scope          TEXT        NOT NULL,
  hour_bucket           TIMESTAMPTZ NOT NULL,
  first_dispatched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  vtid                  TEXT        NULL,
  PRIMARY KEY (class, normalized_signature, gateway_revision, tenant_scope, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_voice_healing_dedupe_first_dispatched_at
  ON public.voice_healing_dedupe (first_dispatched_at);

COMMENT ON TABLE public.voice_healing_dedupe IS
  'VTID-01959 (PR #2): Voice Self-Healing Loop dedupe. 5-tuple PK collapses voice OASIS error events into one self-healing dispatch per (class, normalized_signature) per gateway_revision per tenant_scope per hour bucket.';

-- Daily retention: drop dedupe rows older than 7 days. The dedupe key
-- already includes hour_bucket so older rows have no purpose.
CREATE OR REPLACE FUNCTION public.voice_healing_dedupe_prune()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.voice_healing_dedupe
   WHERE first_dispatched_at < NOW() - INTERVAL '7 days';
END;
$$;

COMMENT ON FUNCTION public.voice_healing_dedupe_prune() IS
  'VTID-01959: Daily pg_cron job — drops voice_healing_dedupe rows older than 7 days. Scheduled at 03:15 UTC.';

-- Schedule the prune via pg_cron. Idempotent: cron.schedule returns the
-- existing job_id if a job with this name already exists. Wrapped in DO
-- block so the migration succeeds even if pg_cron is not loaded in some
-- environments (CI staging).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'voice-healing-dedupe-prune',
      '15 3 * * *',
      $cron$SELECT public.voice_healing_dedupe_prune()$cron$
    );
  END IF;
END $$;
