\set ON_ERROR_STOP on

\echo '=== Recent llm.call.* events for planner stage ==='
SELECT created_at,
       topic,
       status,
       metadata->>'stage' AS stage,
       metadata->>'provider' AS provider,
       metadata->>'model' AS model,
       metadata->>'fallback_used' AS fallback_used,
       metadata->>'fallback_from' AS fallback_from,
       metadata->>'fallback_to' AS fallback_to,
       left(message, 100) AS message
FROM oasis_events
WHERE topic IN ('llm.call.completed', 'llm.call.failed')
  AND created_at >= now() - interval '4 hours'
  AND metadata->>'stage' = 'planner'
ORDER BY created_at DESC
LIMIT 20;

\echo ''
\echo '=== Aggregate planner calls by model + provider + fallback ==='
SELECT metadata->>'provider' AS provider,
       metadata->>'model' AS model,
       metadata->>'fallback_used' AS fallback_used,
       metadata->>'fallback_from' AS fallback_from,
       count(*)
FROM oasis_events
WHERE topic IN ('llm.call.completed', 'llm.call.failed')
  AND created_at >= now() - interval '4 hours'
  AND metadata->>'stage' = 'planner'
GROUP BY 1,2,3,4
ORDER BY count(*) DESC;

\echo ''
\echo '=== Worker calls aggregate ==='
SELECT metadata->>'provider' AS provider,
       metadata->>'model' AS model,
       metadata->>'fallback_used' AS fallback_used,
       count(*)
FROM oasis_events
WHERE topic IN ('llm.call.completed', 'llm.call.failed')
  AND created_at >= now() - interval '4 hours'
  AND metadata->>'stage' = 'worker'
GROUP BY 1,2,3
ORDER BY count(*) DESC;
