SELECT id,
       kill_switch,
       auto_approve_enabled,
       daily_budget,
       concurrency_cap,
       cooldown_minutes,
       updated_at
FROM dev_autopilot_config
WHERE id = 1;
