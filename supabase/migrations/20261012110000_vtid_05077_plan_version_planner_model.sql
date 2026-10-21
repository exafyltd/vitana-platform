-- VTID-05077 (Dev Autopilot autonomy, Phase A2): every plan version records
-- which provider/model actually wrote it, so a planner fallback (DeepSeek →
-- Bedrock Opus 4.6) is visible per plan instead of only in LLM telemetry.
-- Additive and nullable: older rows stay NULL, older gateway code ignores them.
ALTER TABLE public.dev_autopilot_plan_versions
  ADD COLUMN IF NOT EXISTS planner_provider text,
  ADD COLUMN IF NOT EXISTS planner_model text;

COMMENT ON COLUMN public.dev_autopilot_plan_versions.planner_provider IS
  'VTID-05077: provider that wrote this plan version (deepseek, or bedrock when the planner fell back). NULL before 2026-10-12.';
COMMENT ON COLUMN public.dev_autopilot_plan_versions.planner_model IS
  'VTID-05077: model id that wrote this plan version. NULL before 2026-10-12.';
