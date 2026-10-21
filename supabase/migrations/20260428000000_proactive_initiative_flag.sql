-- =============================================================================
-- vitana_proactive_initiative_enabled — V2 Proactive Initiative Engine flag
-- Plan: .claude/plans/proactive-did-you-generic-sifakis.md (V2 section)
-- Date: 2026-04-28
--
-- Default FALSE; flip to TRUE via a follow-up one-off migration after the
-- voice smoke test on the deployed gateway lands clean (mirrors the DYK
-- flag-flip pattern from PR #896).
--
-- Idempotent: ON CONFLICT (key) DO NOTHING.
-- =============================================================================

INSERT INTO public.system_controls (key, enabled, scope, reason, expires_at, updated_by, updated_by_role, updated_at)
VALUES (
  'vitana_proactive_initiative_enabled',
  FALSE,
  '{"environment": "dev-sandbox"}'::jsonb,
  'V2 Proactive Initiative Engine — pairs ORB session-start opener with executable actions (save_diary_entry, activate_recommendation, send_chat_message). Plan: .claude/plans/proactive-did-you-generic-sifakis.md',
  NULL,
  'migration',
  'system',
  NOW()
)
ON CONFLICT (key) DO NOTHING;
