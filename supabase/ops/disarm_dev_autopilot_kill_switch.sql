-- One-shot operational SQL to DISARM the Dev Autopilot kill switch.
-- Run via RUN-MIGRATION.yml after the duplicate-PR guard has shipped and
-- the queue of stuck duplicate PRs has been reconciled.

\set ON_ERROR_STOP on

UPDATE dev_autopilot_config
SET kill_switch = false,
    updated_at = now()
WHERE id = 1;

SELECT id, kill_switch, updated_at
FROM dev_autopilot_config
WHERE id = 1;
