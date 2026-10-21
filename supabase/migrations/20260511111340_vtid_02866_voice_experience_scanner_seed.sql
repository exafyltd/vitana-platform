-- VTID-02866: Seed voice-experience-scanner-v1 in dev_autopilot_scanners.
--
-- Mirrors the entry added to scripts/ci/scanners/registry.mjs. The two
-- must stay aligned so:
--   - dev-autopilot-scan.mjs (CI) finds the scanner in code
--   - GET /api/v1/dev-autopilot/scanners (Command Hub view) finds the
--     matching DB row to join with live scan counts
--
-- Filesystem-only scanner — DB-dependent checks for voice (provider drift,
-- failure-classes-without-rule) live in the Voice Improve aggregator
-- (PR A source #7) instead.

INSERT INTO dev_autopilot_scanners
  (scanner, title, description, signal_type, category, maturity,
   default_severity, default_risk_class, enabled)
VALUES
  ('voice-experience-scanner-v1',
   'Voice experience readiness',
   'Filesystem checks for the voice stack: stale awareness signals (wired:not_wired without enforcement_pending), watchdogs without an oasis_topic, voice routes missing auth middleware, hardcoded TTS speakingRate literals (regression of VTID-02857 wiring).',
   'voice_health', 'quality', 'beta', 'medium', 'medium', TRUE)
ON CONFLICT (scanner) DO UPDATE SET
  title              = EXCLUDED.title,
  description        = EXCLUDED.description,
  signal_type        = EXCLUDED.signal_type,
  category           = EXCLUDED.category,
  maturity           = EXCLUDED.maturity,
  default_severity   = EXCLUDED.default_severity,
  default_risk_class = EXCLUDED.default_risk_class,
  -- Preserve operator-set `enabled` — don't overwrite a manual toggle.
  updated_at         = NOW();
