SELECT json_build_object(
  'columns', (SELECT json_agg(column_name ORDER BY ordinal_position)
              FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'oasis_events'),
  'events', (SELECT COALESCE(json_agg(row_to_json(e)), '[]'::json)
             FROM (SELECT * FROM oasis_events
                   WHERE message LIKE 'latency %ms%'
                     AND created_at > '2026-06-12 15:39:00+00'
                   ORDER BY created_at DESC LIMIT 20) e)
) AS result
