-- DOWN / rollback for 20260808_vcaop_mesh_factory_0001 (VTID-03535).
-- Drops only the 8 Commerce Mesh factory tables; every pre-existing VCAOP and
-- OASIS table is untouched. CASCADE removes the FK constraints and indexes
-- created by the up migration. Verified up->down->up on ephemeral Postgres 16.
DROP TABLE IF EXISTS "connector_certification" CASCADE;
DROP TABLE IF EXISTS "mapping_decision" CASCADE;
DROP TABLE IF EXISTS "schema_mapping" CASCADE;
DROP TABLE IF EXISTS "schema_source" CASCADE;
DROP TABLE IF EXISTS "partner_capability" CASCADE;
DROP TABLE IF EXISTS "integration_version" CASCADE;
DROP TABLE IF EXISTS "integration_manifest" CASCADE;
DROP TABLE IF EXISTS "partner_tenant" CASCADE;
