-- RLS Policies: 003_vtid_ledger.sql
-- Purpose: Row-Level Security policies for VtidLedger table
-- Date: 2025-10-28
-- Task: 4A - VTID Numbering System

-- Enable RLS on VtidLedger
ALTER TABLE "VtidLedger" ENABLE ROW LEVEL SECURITY;

-- Policy 1: service_role has full access (for backend services)
CREATE POLICY "service_role_full_access_vtid"
ON "VtidLedger"
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Policy 2: authenticated users can read all VTIDs (read-only for most users)
CREATE POLICY "authenticated_read_vtid"
ON "VtidLedger"
FOR SELECT
TO authenticated
USING (true);

-- Policy 3: authenticated users can insert VTIDs (for task creation)
CREATE POLICY "authenticated_insert_vtid"
ON "VtidLedger"
FOR INSERT
TO authenticated
WITH CHECK (true);

-- Policy 4: authenticated users can update their own tenant's VTIDs
CREATE POLICY "authenticated_update_own_tenant_vtid"
ON "VtidLedger"
FOR UPDATE
TO authenticated
USING (
    tenant = current_setting('request.jwt.claims', true)::json->>'tenant'
    OR current_setting('request.jwt.claims', true)::json->>'role' = 'admin'
)
WITH CHECK (
    tenant = current_setting('request.jwt.claims', true)::json->>'tenant'
    OR current_setting('request.jwt.claims', true)::json->>'role' = 'admin'
);

-- Grant necessary permissions
GRANT SELECT, INSERT, UPDATE ON "VtidLedger" TO authenticated;
GRANT ALL ON "VtidLedger" TO service_role;

COMMENT ON POLICY "service_role_full_access_vtid" ON "VtidLedger" IS 'Backend services have full access to all VTIDs';
COMMENT ON POLICY "authenticated_read_vtid" ON "VtidLedger" IS 'Authenticated users can read all VTIDs for transparency';
COMMENT ON POLICY "authenticated_insert_vtid" ON "VtidLedger" IS 'Authenticated users can create new VTIDs';
COMMENT ON POLICY "authenticated_update_own_tenant_vtid" ON "VtidLedger" IS 'Users can update VTIDs for their own tenant or if they are admin';
