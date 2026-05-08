\set ON_ERROR_STOP on

\echo '=== Recent llm.call.* events for planner stage ==='
SELECT created_at,
       topic,
       status,
       payload->>'stage' AS stage,
       payload->>'provider' AS provider,
       payload->>'model' AS model,
       payload->>'fallback_used' AS fallback_used,
       payload->>'fallback_from' AS fallback_from,
       payload->>'fallback_to' AS fallback_to,
       left(message, 100) AS message
FROM oasis_events
WHERE topic IN ('llm.call.completed', 'llm.call.failed')
  AND created_at >= now() - interval '4 hours'
  AND payload->>'stage' = 'planner'
ORDER BY created_at DESC
LIMIT 20;

\echo ''
\echo '=== Aggregate planner calls by model + provider + fallback ==='
SELECT payload->>'provider' AS provider,
       payload->>'model' AS model,
       payload->>'fallback_used' AS fallback_used,
       payload->>'fallback_from' AS fallback_from,
       count(*)
FROM oasis_events
WHERE topic IN ('llm.call.completed', 'llm.call.failed')
  AND created_at >= now() - interval '4 hours'
  AND payload->>'stage' = 'planner'
GROUP BY 1,2,3,4
ORDER BY count(*) DESC;

\echo ''
\echo '=== Worker calls aggregate ==='
SELECT payload->>'provider' AS provider,
       payload->>'model' AS model,
       payload->>'fallback_used' AS fallback_used,
       count(*)
FROM oasis_events
WHERE topic IN ('llm.call.completed', 'llm.call.failed')
  AND created_at >= now() - interval '4 hours'
  AND payload->>'stage' = 'worker'
GROUP BY 1,2,3
ORDER BY count(*) DESC;
