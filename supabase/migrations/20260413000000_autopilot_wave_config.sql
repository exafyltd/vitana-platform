-- Add wave_config JSONB column to tenant_autopilot_settings
-- Stores per-tenant wave overrides (enabled/disabled, order, etc.)
-- Empty object {} means "use defaults from wave-defaults.ts"

ALTER TABLE tenant_autopilot_settings
ADD COLUMN IF NOT EXISTS wave_config JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN tenant_autopilot_settings.wave_config IS
  'Per-tenant wave configuration overrides. Empty object = use defaults.';
