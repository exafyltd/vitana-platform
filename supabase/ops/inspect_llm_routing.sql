\set ON_ERROR_STOP on

\echo '=== Current llm_routing_policy ==='
SELECT id, environment, is_active,
       jsonb_pretty(policy) AS policy,
       created_at
FROM llm_routing_policy
WHERE is_active = true
ORDER BY created_at DESC;
