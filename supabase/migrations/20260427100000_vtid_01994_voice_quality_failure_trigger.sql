-- VTID-01994: Allow 'quality_failure' as trigger_reason for Architecture
-- Investigator reports. Quality failures are detected from session-stop
-- metrics (audio_in:audio_out ratio, turn count, duration) — no error
-- events required. They route directly to the investigator because the
-- root cause is usually at the prompt / model-config layer, not the
-- pipeline layer.
--
-- Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md

ALTER TABLE public.voice_architecture_reports
  DROP CONSTRAINT IF EXISTS voice_architecture_reports_trigger_reason_chk;

ALTER TABLE public.voice_architecture_reports
  ADD CONSTRAINT voice_architecture_reports_trigger_reason_chk
  CHECK (trigger_reason IN (
    'sentinel_quarantine',
    'spec_memory_blocked',
    'quality_failure',
    'manual'
  ));
