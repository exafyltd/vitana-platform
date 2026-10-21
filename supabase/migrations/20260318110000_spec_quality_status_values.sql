-- Add quality_checked and quality_failed to spec_status CHECK constraint
-- Required by the Spec Quality Agent gate (quality-check endpoint)

-- Drop old constraint and create new one with expanded values
ALTER TABLE vtid_ledger DROP CONSTRAINT IF EXISTS vtid_ledger_spec_status_check;

ALTER TABLE vtid_ledger ADD CONSTRAINT vtid_ledger_spec_status_check
  CHECK (spec_status IN (
    'missing',
    'generating',
    'draft',
    'validating',
    'validated',
    'rejected',
    'quality_checked',
    'quality_failed',
    'approved'
  ));
