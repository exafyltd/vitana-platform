-- One-shot operational SQL to DISABLE Dev Autopilot auto-approve.

\set ON_ERROR_STOP on

UPDATE dev_autopilot_config
SET auto_approve_enabled = false,
    updated_at = now()
WHERE id = 1;

SELECT id, auto_approve_enabled, kill_switch, daily_budget, concurrency_cap, updated_at
FROM dev_autopilot_config
WHERE id = 1;
