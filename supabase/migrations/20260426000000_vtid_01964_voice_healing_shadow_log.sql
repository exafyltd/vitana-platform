-- VTID-01964: Voice Self-Healing Shadow Mode decision log (PR #7)
--
-- Append-only log of every adapter decision (regardless of action/outcome).
-- The Healing dashboard (PR #8) joins this against oasis_events to compute
-- the would-dispatch vs actual-outcome comparison view that ops uses to
-- validate Shadow Mode before flipping mode=live.
--
-- Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md (PR #7 of 9
-- in the autonomous ORB voice self-healing loop).

CREATE TABLE IF NOT EXISTS public.voice_healing_shadow_log (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  decided_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  mode                  TEXT         NOT NULL,
  action                TEXT         NOT NULL,
  class                 TEXT         NULL,
  normalized_signature  TEXT         NULL,
  spec_hash             TEXT         NULL,
  detail                TEXT         NULL,
  session_id            TEXT         NULL,
  tenant_scope          TEXT         NULL,
  gateway_revision      TEXT         NULL
);

ALTER TABLE public.voice_healing_shadow_log
  DROP CONSTRAINT IF EXISTS voice_healing_shadow_log_mode_chk;

ALTER TABLE public.voice_healing_shadow_log
  ADD CONSTRAINT voice_healing_shadow_log_mode_chk
  CHECK (mode IN ('off', 'shadow', 'live'));

CREATE INDEX IF NOT EXISTS idx_voice_healing_shadow_log_decided_at
  ON public.voice_healing_shadow_log (decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_voice_healing_shadow_log_class_decided_at
  ON public.voice_healing_shadow_log (class, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_voice_healing_shadow_log_session
  ON public.voice_healing_shadow_log (session_id, decided_at DESC);

COMMENT ON TABLE public.voice_healing_shadow_log IS
  'VTID-01964 (PR #7): Voice Self-Healing Shadow Mode decision log. One row per adapter call regardless of action. Used by PR #8 dashboard to compute would-dispatch vs actual-outcome comparison.';

-- 30-day retention is enough for the shadow comparison window. The
-- aggregate metrics in the dashboard (success rate, time-to-fix, etc.)
-- are derived counts, not row-level details.
CREATE OR REPLACE FUNCTION public.voice_healing_shadow_log_prune()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.voice_healing_shadow_log
   WHERE decided_at < NOW() - INTERVAL '30 days';
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'voice-healing-shadow-log-prune',
      '30 3 * * *',
      $cron$SELECT public.voice_healing_shadow_log_prune()$cron$
    );
  END IF;
END $$;
