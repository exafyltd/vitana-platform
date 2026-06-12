SELECT created_at, message,
       payload->>'surface' AS surface,
       payload->>'transport' AS transport,
       payload->>'turn' AS turn,
       payload->>'total_ms' AS total_ms,
       payload->>'session_id' AS session_id,
       payload->'phases' AS phases
FROM oasis_events
WHERE type = 'voice.latency.measured'
  AND created_at > '2026-06-12 15:39:00+00'
ORDER BY created_at DESC
LIMIT 20
