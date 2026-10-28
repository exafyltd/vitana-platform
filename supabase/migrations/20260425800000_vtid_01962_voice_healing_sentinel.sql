-- VTID-01962: Recurrence Sentinel — history + quarantine state machine (PR #5)
--
-- voice_healing_history: append-only row per dispatch verdict. Sentinel
-- reads this table in 24h / 7d windows to evaluate the three thresholds
-- (burst, persistence, failed-fix) and decide whether to quarantine.
--
-- voice_healing_quarantine: per-(class, signature) state machine —
-- active → quarantined → probation → released.
--
-- Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md (PR #5 of 9
-- in the autonomous ORB voice self-healing loop).

-- =============================================================================
-- voice_healing_history
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.voice_healing_history (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  class                    TEXT         NOT NULL,
  normalized_signature     TEXT         NOT NULL,
  dispatched_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  verdict                  TEXT         NOT NULL,
  fixed_at                 TIMESTAMPTZ  NULL,
  recurrence_after_fix_ms  BIGINT       NULL,
  gateway_revision         TEXT         NULL,
  tenant_scope             TEXT         NULL,
  vtid                     TEXT         NULL
);

ALTER TABLE public.voice_healing_history
  DROP CONSTRAINT IF EXISTS voice_healing_history_verdict_chk;

ALTER TABLE public.voice_healing_history
  ADD CONSTRAINT voice_healing_history_verdict_chk
  CHECK (verdict IN ('ok', 'rollback', 'partial', 'suppressed'));

CREATE INDEX IF NOT EXISTS idx_voice_healing_history_class_dispatched_at
  ON public.voice_healing_history (class, dispatched_at DESC);

CREATE INDEX IF NOT EXISTS idx_voice_healing_history_signature
  ON public.voice_healing_history (normalized_signature, dispatched_at DESC);

CREATE INDEX IF NOT EXISTS idx_voice_healing_history_class_signature_dispatched_at
  ON public.voice_healing_history (class, normalized_signature, dispatched_at DESC);

COMMENT ON TABLE public.voice_healing_history IS
  'VTID-01962 (PR #5): Voice Self-Healing history — append-only verdict log keyed on (class, normalized_signature). Sentinel reads this in 24h/7d windows to evaluate burst / persistence / failed-fix thresholds.';

-- 90-day retention (matches spec_memory)
CREATE OR REPLACE FUNCTION public.voice_healing_history_prune()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.voice_healing_history
   WHERE dispatched_at < NOW() - INTERVAL '90 days';
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'voice-healing-history-prune',
      '25 3 * * *',
      $cron$SELECT public.voice_healing_history_prune()$cron$
    );
  END IF;
END $$;

-- =============================================================================
-- voice_healing_quarantine
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.voice_healing_quarantine (
  class                  TEXT         NOT NULL,
  normalized_signature   TEXT         NOT NULL,
  status                 TEXT         NOT NULL DEFAULT 'active',
  quarantined_at         TIMESTAMPTZ  NULL,
  reason                 TEXT         NULL,
  probation_until        TIMESTAMPTZ  NULL,
  investigation_id       UUID         NULL,
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (class, normalized_signature)
);

ALTER TABLE public.voice_healing_quarantine
  DROP CONSTRAINT IF EXISTS voice_healing_quarantine_status_chk;

ALTER TABLE public.voice_healing_quarantine
  ADD CONSTRAINT voice_healing_quarantine_status_chk
  CHECK (status IN ('active', 'quarantined', 'probation', 'released'));

CREATE INDEX IF NOT EXISTS idx_voice_healing_quarantine_status
  ON public.voice_healing_quarantine (status)
  WHERE status IN ('quarantined', 'probation');

COMMENT ON TABLE public.voice_healing_quarantine IS
  'VTID-01962 (PR #5): Voice Self-Healing quarantine state machine per (class, normalized_signature). Statuses: active (default, dispatch normally), quarantined (auto-set by Sentinel — adapter short-circuits), probation (set by ops via /quarantine/release — halved thresholds + max 1 dispatch/day for 72h), released (probation completed without re-quarantine).';
