-- Migration: 20260427000002_vtid_01984_exec_deploy_terminal_gate_auth.sql
-- Purpose: Allocate VTID-01984 — Fix EXEC-DEPLOY OASIS Terminal Completion Gate auth
-- Advances global_vtid_seq to 1984 so future allocations start at 1985+

-- ============================================================================
-- Step 1: Advance sequence past 1984 to prevent future conflict
-- ============================================================================
DO $$
BEGIN
  IF (SELECT last_value FROM global_vtid_seq) < 1984 THEN
    PERFORM setval('global_vtid_seq', 1984);
  END IF;
END $$;

-- ============================================================================
-- Step 2: Insert VTID-01984 row with approved+in_progress governance state
-- ============================================================================
INSERT INTO vtid_ledger (
  id,
  vtid,
  title,
  status,
  spec_status,
  is_terminal,
  terminal_outcome,
  failure_count,
  tenant,
  layer,
  module,
  task_family,
  task_type,
  summary,
  description,
  is_test,
  metadata,
  created_at,
  updated_at
) VALUES (
  gen_random_uuid()::TEXT,
  'VTID-01984',
  'Fix EXEC-DEPLOY OASIS Terminal Completion Gate auth',
  'in_progress',
  'approved',
  false,
  NULL,
  0,
  'vitana',
  'INFRA',
  'CICD',
  'INFRA',
  'CICD',
  'Add Authorization: Bearer header (SUPABASE_SERVICE_ROLE from GCP Secret Manager) to terminal completion gate curl in EXEC-DEPLOY workflow. Gate was returning 401 UNAUTHENTICATED on every deploy.',
  '',
  false,
  jsonb_build_object(
    'source', 'migration',
    'allocated_at', NOW()::TEXT,
    'allocator_version', 'VTID-01984',
    'purpose', 'Fix CI/CD terminal gate authentication — OASIS Hard Gate VTID-01080'
  ),
  NOW(),
  NOW()
) ON CONFLICT (vtid) DO NOTHING;
