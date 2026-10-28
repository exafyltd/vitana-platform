-- ============================================================================
-- VTID-01228: Daily.co Video Integration for LIVE Rooms
-- DOWN Migration (Rollback)
-- ============================================================================

-- Drop RPC functions
DROP FUNCTION IF EXISTS live_room_update_metadata(UUID, JSONB);
DROP FUNCTION IF EXISTS live_room_get(UUID);
DROP FUNCTION IF EXISTS live_room_invalidate_all_grants(UUID);
DROP FUNCTION IF EXISTS live_room_revoke_access(UUID, TEXT);
DROP FUNCTION IF EXISTS live_room_grant_access(UUID, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS live_room_check_access(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS live_room_check_access(UUID, UUID);

-- Drop view
DROP VIEW IF EXISTS live_rooms_public;

-- Drop indexes
DROP INDEX IF EXISTS idx_access_grants_unique;
DROP INDEX IF EXISTS idx_access_grants_payment;
DROP INDEX IF EXISTS idx_access_grants_tenant;
DROP INDEX IF EXISTS idx_access_grants_room;
DROP INDEX IF EXISTS idx_access_grants_user;

-- Drop table
DROP TABLE IF EXISTS live_room_access_grants;

-- Remove access_level column from live_rooms
ALTER TABLE live_rooms DROP COLUMN IF EXISTS access_level;

-- Log rollback
DO $$
BEGIN
  RAISE NOTICE 'VTID-01228 rollback complete - Daily.co Live Rooms integration removed';
END $$;
