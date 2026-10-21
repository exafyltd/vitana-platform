-- DOWN / rollback for 20260808_vcaop_mesh_health_0004 (VTID-03541/03547).
--
-- ⚠ F13 (privacy review 2026-08-09): consent receipts are the legally
-- significant record of consent. Once this migration has served live
-- traffic, receipts MUST be exported/archived BEFORE running this rollback
-- — this file destroys them, and the append-only trigger does not protect
-- against DROP TABLE. Do not run against a live database without a
-- recorded export.
DROP TABLE IF EXISTS "insurance_quote" CASCADE;
DROP TABLE IF EXISTS "health_data_attestation" CASCADE;
DROP TABLE IF EXISTS "consent_receipt" CASCADE;
DROP TABLE IF EXISTS "consent_grant" CASCADE;
DROP FUNCTION IF EXISTS _consent_receipt_immutable() CASCADE;
