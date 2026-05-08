\set ON_ERROR_STOP on

\echo '=== Recent llm_router_calls — what model actually got used? ==='
SELECT created_at,
       role,
       provider_used,
       model_used,
       fallback_used,
       success,
       left(error, 100) AS error
FROM llm_router_calls
WHERE created_at >= now() - interval '4 hours'
ORDER BY created_at DESC
LIMIT 30;

\echo ''
\echo '=== Aggregate by role + model (last 4h) ==='
SELECT role, provider_used, model_used, success, count(*)
FROM llm_router_calls
WHERE created_at >= now() - interval '4 hours'
GROUP BY 1,2,3,4
ORDER BY count(*) DESC;
