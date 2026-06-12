SELECT created_at, message, row_to_json(e) AS row
FROM oasis_events e
WHERE type = 'voice.latency.measured'
  AND created_at > '2026-06-12 15:39:00+00'
ORDER BY created_at DESC
LIMIT 20
