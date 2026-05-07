-- Why is autoApproveTick silent? Check OASIS events for any autopilot
-- activity since auto_approve was re-enabled.

\set ON_ERROR_STOP on

\echo '=== Recent OASIS events (last 15 min, any topic) ==='
SELECT created_at, topic, status, left(message, 110) AS message
FROM oasis_events
WHERE created_at >= now() - interval '15 minutes'
  AND topic ~ '(dev_autopilot|autopilot)'
ORDER BY created_at DESC
LIMIT 30;

\echo ''
\echo '=== ANY recent autopilot activity (last 20 min) ==='
SELECT count(*) AS events_last_20m
FROM oasis_events
WHERE created_at >= now() - interval '20 minutes'
  AND topic ~ '(dev_autopilot|autopilot)';

\echo ''
\echo '=== Most recent dev_autopilot.execution.* events (any time) ==='
SELECT created_at, topic, left(message, 110) AS message
FROM oasis_events
WHERE topic LIKE 'dev_autopilot.execution.%'
ORDER BY created_at DESC
LIMIT 5;
