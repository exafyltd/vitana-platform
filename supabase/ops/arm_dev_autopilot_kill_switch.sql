-- One-shot operational SQL to ARM the Dev Autopilot kill switch.
-- Run via RUN-MIGRATION.yml against this file path.
-- Disarm with disarm_dev_autopilot_kill_switch.sql once the duplicate-PR
-- guard has shipped and been verified in production.

\set ON_ERROR_STOP on

UPDATE dev_autopilot_config
SET kill_switch = true,
    updated_at = now()
WHERE id = 1;

SELECT id, kill_switch, updated_at
FROM dev_autopilot_config
WHERE id = 1;
