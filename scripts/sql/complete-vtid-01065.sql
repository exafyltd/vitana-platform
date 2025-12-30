-- VTID-01065: Emit lifecycle completion event
-- Run this against the Supabase database to move task to COMPLETED

INSERT INTO oasis_events (
  id,
  created_at,
  vtid,
  topic,
  service,
  role,
  model,
  status,
  message,
  link,
  metadata
) VALUES (
  gen_random_uuid(),
  NOW(),
  'VTID-01065',
  'vtid.lifecycle.completed',
  'vtid-lifecycle-claude',
  'CICD',
  'autonomous-safe-merge',
  'success',
  'Validator-Agent Ruleset implemented: gov/validator-rules.yaml and VALIDATOR-CHECK.yml workflow merged to main',
  NULL,
  jsonb_build_object(
    'vtid', 'VTID-01065',
    'outcome', 'success',
    'source', 'claude',
    'terminal', true,
    'completed_at', NOW()::text,
    'deliverables', jsonb_build_array(
      'gov/validator-rules.yaml',
      '.github/workflows/VALIDATOR-CHECK.yml'
    )
  )
);

-- Also update vtid_ledger status to 'complete' for consistency
UPDATE vtid_ledger
SET status = 'complete',
    updated_at = NOW()
WHERE vtid = 'VTID-01065';
