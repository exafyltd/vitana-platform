-- Seed data for testing Task 4B Phase 2
-- Insert test event into oasis_events

INSERT INTO oasis_events (
  vtid,
  topic,
  service,
  role,
  model,
  status,
  message,
  link
) VALUES (
  'VTID-2025-4B02',
  'task.complete',
  'gateway',
  'WORKER',
  'claude-sonnet-4',
  'success',
  'Task 4B Phase 2 - Events API deployed successfully',
  NULL
);

-- Query to verify
SELECT * FROM oasis_events ORDER BY created_at DESC LIMIT 5;
