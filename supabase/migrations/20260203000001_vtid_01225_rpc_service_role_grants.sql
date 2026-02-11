-- Migration: 20260203000001_vtid_01225_rpc_service_role_grants.sql
-- Purpose: VTID-01225 Cognee Integration - Add service_role grants for RPC calls
-- Date: 2026-02-03
--
-- The Cognee entity extraction persistence runs in the gateway service using
-- the service_role key. Without this grant, RPC calls fail with permission denied.
--
-- Dependencies:
--   - VTID-01087 (relationship_ensure_node function)

-- ===========================================================================
-- Grant service_role access to relationship_ensure_node
-- Required for Cognee extraction persistence to create relationship nodes
-- ===========================================================================

GRANT EXECUTE ON FUNCTION public.relationship_ensure_node(TEXT, TEXT, UUID, TEXT, JSONB) TO service_role;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON FUNCTION public.relationship_ensure_node IS
  'VTID-01087 + VTID-01225: Create or update relationship node. Now grants to service_role for Cognee extraction persistence.';
