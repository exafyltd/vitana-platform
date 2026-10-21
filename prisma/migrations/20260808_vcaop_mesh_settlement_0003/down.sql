-- DOWN / rollback for 20260808_vcaop_mesh_settlement_0003 (VTID-03540).
DROP TABLE IF EXISTS "connector_usage_record" CASCADE;
DROP TABLE IF EXISTS "settlement_instruction" CASCADE;
