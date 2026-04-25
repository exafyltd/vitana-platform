-- VTID-01960: Voice Self-Healing Spec Memory table (PR #3)
--
-- Records (spec_hash, normalized_signature, outcome) tuples so the adapter's
-- Spec Memory Gate can refuse to dispatch the same spec twice for the same
-- signature within a 72-hour window. This is the spec-level anti-loop control
-- — class-level quarantine (PR #5) is the second layer.
--
-- Outcome values:
--   success      — fix dispatched and synthetic probe (PR #4) reported pass.
--   probe_failed — fix dispatched but synthetic probe failed.
--   rollback    — fix dispatched and triggered auto-rollback.
--   partial     — fix dispatched, probe partial-pass (some criteria, not all).
--
-- Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md (PR #3 of 9
-- in the autonomous ORB voice self-healing loop).

CREATE TABLE IF NOT EXISTS public.voice_healing_spec_memory (
  spec_hash             TEXT        NOT NULL,
  normalized_signature  TEXT        NOT NULL,
  attempted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome               TEXT        NOT NULL,
  vtid                  TEXT        NULL,
  evidence_ref          UUID        NULL,
  detail                TEXT        NULL,
  PRIMARY KEY (spec_hash, normalized_signature, attempted_at)
);

CREATE INDEX IF NOT EXISTS idx_voice_healing_spec_memory_signature
  ON public.voice_healing_spec_memory (normalized_signature, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_voice_healing_spec_memory_attempted_at
  ON public.voice_healing_spec_memory (attempted_at);

ALTER TABLE public.voice_healing_spec_memory
  DROP CONSTRAINT IF EXISTS voice_healing_spec_memory_outcome_chk;

ALTER TABLE public.voice_healing_spec_memory
  ADD CONSTRAINT voice_healing_spec_memory_outcome_chk
  CHECK (outcome IN ('success', 'probe_failed', 'rollback', 'partial'));

COMMENT ON TABLE public.voice_healing_spec_memory IS
  'VTID-01960 (PR #3): Voice Self-Healing Spec Memory. Adapter consults this table before dispatch — a (spec_hash, normalized_signature) pair that has a probe_failed or rollback row in the last 72h is blocked from re-dispatch and routed to the Architecture Investigator (PR #6).';

-- Daily retention: drop spec_memory rows older than 90 days. The gate's
-- lookup window is 72h so older rows have no operational value, but keep
-- 90 days for trend analysis on the Healing dashboard (PR #8).
CREATE OR REPLACE FUNCTION public.voice_healing_spec_memory_prune()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.voice_healing_spec_memory
   WHERE attempted_at < NOW() - INTERVAL '90 days';
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'voice-healing-spec-memory-prune',
      '20 3 * * *',
      $cron$SELECT public.voice_healing_spec_memory_prune()$cron$
    );
  END IF;
END $$;
