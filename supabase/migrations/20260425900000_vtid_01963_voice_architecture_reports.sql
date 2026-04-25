-- VTID-01963: Architecture Investigator reports table (PR #6)
--
-- When the Recurrence Sentinel (PR #5) quarantines a (class, signature) or
-- the Spec Memory Gate (PR #3) blocks a dispatch, the Architecture
-- Investigator runs and produces a structured report (per-hypothesis
-- confidence, top-3 disconfirming evidence, >=3 alternative
-- architectures). The report is persisted here for ops review in the
-- Healing dashboard (PR #8).
--
-- The recommendation in the report is NEVER auto-executed — architectural
-- pivots remain a human decision.
--
-- Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md (PR #6 of 9
-- in the autonomous ORB voice self-healing loop).

CREATE TABLE IF NOT EXISTS public.voice_architecture_reports (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  class                 TEXT         NOT NULL,
  normalized_signature  TEXT         NULL,
  generated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  trigger_reason        TEXT         NOT NULL,
  schema_version        TEXT         NOT NULL DEFAULT 'v1',
  report                JSONB        NOT NULL,
  status                TEXT         NOT NULL DEFAULT 'open',
  acknowledged_by       TEXT         NULL,
  acknowledged_at       TIMESTAMPTZ  NULL,
  decision_notes        TEXT         NULL,
  related_quarantine_class TEXT       NULL,
  related_quarantine_signature TEXT   NULL,
  related_spec_hash     TEXT         NULL,
  related_vtid          TEXT         NULL
);

ALTER TABLE public.voice_architecture_reports
  DROP CONSTRAINT IF EXISTS voice_architecture_reports_status_chk;

ALTER TABLE public.voice_architecture_reports
  ADD CONSTRAINT voice_architecture_reports_status_chk
  CHECK (status IN ('open', 'acknowledged', 'accepted', 'rejected'));

ALTER TABLE public.voice_architecture_reports
  DROP CONSTRAINT IF EXISTS voice_architecture_reports_trigger_reason_chk;

ALTER TABLE public.voice_architecture_reports
  ADD CONSTRAINT voice_architecture_reports_trigger_reason_chk
  CHECK (trigger_reason IN (
    'sentinel_quarantine',
    'spec_memory_blocked',
    'manual'
  ));

CREATE INDEX IF NOT EXISTS idx_voice_architecture_reports_class_generated_at
  ON public.voice_architecture_reports (class, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_voice_architecture_reports_status
  ON public.voice_architecture_reports (status, generated_at DESC)
  WHERE status = 'open';

COMMENT ON TABLE public.voice_architecture_reports IS
  'VTID-01963 (PR #6): Architecture Investigator reports. Structured output with per-hypothesis confidence, top-3 disconfirming evidence, and >=3 alternative architectures (LiveKit, OpenAI Realtime, Pipecat, Deepgram, Cartesia, ElevenLabs, Vapi, Retell, etc.). Recommendation is NEVER auto-executed — human decision.';
