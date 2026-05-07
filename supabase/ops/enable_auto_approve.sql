-- One-shot operational SQL to ENABLE Dev Autopilot auto-approve.
-- Pair with disable_auto_approve.sql to flip back off after the test.

\set ON_ERROR_STOP on

UPDATE dev_autopilot_config
SET auto_approve_enabled = true,
    updated_at = now()
WHERE id = 1;

SELECT id, auto_approve_enabled, kill_switch, daily_budget, concurrency_cap, updated_at
FROM dev_autopilot_config
WHERE id = 1;
