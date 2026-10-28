-- VTID-02978 (M1): worker-runner contract coverage.
--
-- Seeds 5 contracts for the worker-runner Cloud Run service:
--   - /alive   (canonical health)
--   - /ready   (kubernetes-style readiness)
--   - /live    (kubernetes-style liveness)
--   - /metrics (runner metrics + active VTID)
--   - /api/v1/canary-target/health (operator-armed canary for the
--     M1 repair-loop green-path proof)
--
-- These mirror gateway's PR-L1 seeds. Failure scanner picks up the new
-- rows automatically (it filters by contract_type=live_probe, agnostic
-- to service). Per-service URL routing lives in
-- services/gateway/src/services/test-contract-config.ts:contractServiceBaseUrl.

INSERT INTO test_contracts (
  capability, contract_type, command_key, service, environment,
  target_file, target_endpoint, expected_behavior, owner, repairable
) VALUES
  (
    'worker_runner_alive',
    'live_probe',
    'worker_runner.alive',
    'worker-runner',
    'dev',
    'services/worker-runner/src/index.ts',
    '/alive',
    '{"status": [200, 503], "content_type_prefix": "application/json", "notes": "503 with status=unhealthy is acceptable — proves the route is mounted + runner state is being reported. text/html 404 means the route is gone."}'::jsonb,
    'worker-runner-core',
    true
  ),
  (
    'worker_runner_ready',
    'live_probe',
    'worker_runner.ready',
    'worker-runner',
    'dev',
    'services/worker-runner/src/index.ts',
    '/ready',
    '{"status": [200, 503], "content_type_prefix": "application/json"}'::jsonb,
    'worker-runner-core',
    true
  ),
  (
    'worker_runner_live',
    'live_probe',
    'worker_runner.live',
    'worker-runner',
    'dev',
    'services/worker-runner/src/index.ts',
    '/live',
    '{"status": [200, 503], "content_type_prefix": "application/json"}'::jsonb,
    'worker-runner-core',
    true
  ),
  (
    'worker_runner_metrics',
    'live_probe',
    'worker_runner.metrics',
    'worker-runner',
    'dev',
    'services/worker-runner/src/index.ts',
    '/metrics',
    '{"status": [200, 503], "content_type_prefix": "application/json"}'::jsonb,
    'worker-runner-core',
    true
  ),
  (
    'worker_runner_canary_target_health',
    'live_probe',
    'worker_runner.canary_target_health',
    'worker-runner',
    'dev',
    'services/worker-runner/src/routes/canary-target.ts',
    '/api/v1/canary-target/health',
    '{"status": 200, "content_type_prefix": "application/json", "json_must_contain": {"ok": true}, "notes": "Disarmed path. When system_config.worker_runner_canary_armed=true the route throws WorkerRunnerCanaryArmedFault and Express surfaces 500 — the failure scanner picks it up. The repair contract is: catch the typed fault, return 200 with degraded shape."}'::jsonb,
    'self-healing',
    true
  )
ON CONFLICT (capability) DO NOTHING;
