-- ============================================
-- OASIS Events - Row Level Security Policies
-- ============================================
-- Purpose: Secure the OasisEvent table with tenant isolation
-- Created: 2025-10-27 (Phase 2B.2 - OASIS Persistence)

-- Enable RLS on the OasisEvent table
ALTER TABLE public."OasisEvent" ENABLE ROW LEVEL SECURITY;

-- Baseline: block all by default
REVOKE ALL ON TABLE public."OasisEvent" FROM anon, authenticated;

-- ============================================
-- POLICY 1: Service-role insert only (Gateway)
-- ============================================
CREATE POLICY oasis_events_insert_service
ON public."OasisEvent"
FOR INSERT
TO authenticated
WITH CHECK ( auth.role() = 'service_role' );

-- ============================================
-- POLICY 2: Tenant-aware reads
-- ============================================
CREATE POLICY oasis_events_select_by_tenant
ON public."OasisEvent"
FOR SELECT
TO authenticated
USING ( tenant = COALESCE((auth.jwt() ->> 'tenant'), 'NO_TENANT') );

-- ============================================
-- POLICY 3: Service role full access (Admin)
-- ============================================
CREATE POLICY oasis_events_service_all
ON public."OasisEvent"
FOR ALL
TO service_role
USING ( true )
WITH CHECK ( true );
