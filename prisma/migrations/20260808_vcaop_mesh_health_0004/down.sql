-- DOWN / rollback for 20260808_vcaop_mesh_health_0004 (VTID-03541).
DROP TABLE IF EXISTS "insurance_quote" CASCADE;
DROP TABLE IF EXISTS "health_data_attestation" CASCADE;
DROP TABLE IF EXISTS "consent_receipt" CASCADE;
DROP TABLE IF EXISTS "consent_grant" CASCADE;
