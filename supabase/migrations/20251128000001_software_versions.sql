-- 20251128000001_software_versions.sql
-- VTID-0510: Software Version Tracking + Deployments History Feed
--
-- Purpose: Create software_versions table for tracking deployments and version history
-- Dependencies: None
-- Follows: MG-001 (Idempotent SQL Requirement)

-- ============================================================================
-- A. CREATE SOFTWARE_VERSIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.software_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  swv_id         text NOT NULL UNIQUE,  -- Format: SWV-####, sequential
  service        text NOT NULL,          -- e.g. "gateway"
  git_commit     text NOT NULL,          -- full SHA
  deploy_type    text NOT NULL CHECK (deploy_type IN ('normal', 'rollback')),
  initiator      text NOT NULL CHECK (initiator IN ('user', 'agent')),
  status         text NOT NULL CHECK (status IN ('success', 'failure')),
  environment    text NOT NULL DEFAULT 'dev-sandbox',
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Add comment for table documentation
COMMENT ON TABLE public.software_versions IS 'VTID-0510: Tracks software version deployments for the Vitana platform';
COMMENT ON COLUMN public.software_versions.swv_id IS 'Software Version ID in format SWV-####';
COMMENT ON COLUMN public.software_versions.service IS 'Service name being deployed (e.g., gateway, oasis)';
COMMENT ON COLUMN public.software_versions.git_commit IS 'Full git commit SHA of the deployment';
COMMENT ON COLUMN public.software_versions.deploy_type IS 'Deployment type: normal or rollback';
COMMENT ON COLUMN public.software_versions.initiator IS 'Who initiated the deployment: user or agent';
COMMENT ON COLUMN public.software_versions.status IS 'Deployment status: success or failure';
COMMENT ON COLUMN public.software_versions.environment IS 'Target environment (defaults to dev-sandbox)';

-- ============================================================================
-- B. CREATE INDEXES
-- ============================================================================

-- Primary index for version lookups and chronological ordering
CREATE INDEX IF NOT EXISTS idx_software_versions_swv_created
  ON public.software_versions (swv_id, created_at DESC);

-- Index for service-based queries
CREATE INDEX IF NOT EXISTS idx_software_versions_service
  ON public.software_versions (service, created_at DESC);

-- Index for status-based queries
CREATE INDEX IF NOT EXISTS idx_software_versions_status
  ON public.software_versions (status);

-- Index for environment-based queries
CREATE INDEX IF NOT EXISTS idx_software_versions_environment
  ON public.software_versions (environment, created_at DESC);

-- ============================================================================
-- C. ENABLE ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.software_versions ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- D. CREATE RLS POLICIES
-- ============================================================================

-- Policy: Read access for all authenticated roles
-- General roles can read deployment history
DROP POLICY IF EXISTS p_software_versions_select ON public.software_versions;
CREATE POLICY p_software_versions_select
  ON public.software_versions
  FOR SELECT
  USING (true);  -- All authenticated users can read

-- Policy: Insert restricted to service_role (Gateway API)
-- Only the service role key can insert new deployment records
DROP POLICY IF EXISTS p_software_versions_insert ON public.software_versions;
CREATE POLICY p_software_versions_insert
  ON public.software_versions
  FOR INSERT
  WITH CHECK (
    -- Only service_role can insert
    current_setting('request.jwt.claim.role', true) = 'service_role'
    OR current_setting('role', true) = 'service_role'
    OR auth.role() = 'service_role'
  );

-- Policy: No updates allowed (immutable audit log)
DROP POLICY IF EXISTS p_software_versions_update ON public.software_versions;
CREATE POLICY p_software_versions_update
  ON public.software_versions
  FOR UPDATE
  USING (false);  -- No updates allowed

-- Policy: No deletes allowed (immutable audit log)
DROP POLICY IF EXISTS p_software_versions_delete ON public.software_versions;
CREATE POLICY p_software_versions_delete
  ON public.software_versions
  FOR DELETE
  USING (false);  -- No deletes allowed

-- ============================================================================
-- E. VERIFY RLS IS ENABLED
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'software_versions'
    AND relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on software_versions table';
  END IF;

  RAISE NOTICE 'VTID-0510: software_versions table created with RLS enabled';
END $$;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- VTID-0510 software_versions table migration applied successfully
