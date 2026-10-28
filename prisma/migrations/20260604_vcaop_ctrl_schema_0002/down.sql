-- DOWN / rollback for CTRL-SCHEMA-0002 (VCAOP Sec. 4.1–4.7)
-- Reverses 20260604_vcaop_ctrl_schema_0002/migration.sql.
-- Drops only the 16 VCAOP tables; leaves the OASIS tables (oasis_events,
-- vtid_ledger, projection_offsets) untouched. CASCADE removes FK constraints
-- and indexes created by the up migration. Verified up->down->up on a fresh DB.
DROP TABLE IF EXISTS "disclosure" CASCADE;
DROP TABLE IF EXISTS "merchant_route" CASCADE;
DROP TABLE IF EXISTS "cart_order" CASCADE;
DROP TABLE IF EXISTS "user_reward_link" CASCADE;
DROP TABLE IF EXISTS "rewards_ledger" CASCADE;
DROP TABLE IF EXISTS "commission_event" CASCADE;
DROP TABLE IF EXISTS "affiliate_program" CASCADE;
DROP TABLE IF EXISTS "account_health_snapshot" CASCADE;
DROP TABLE IF EXISTS "human_task" CASCADE;
DROP TABLE IF EXISTS "job_artifact" CASCADE;
DROP TABLE IF EXISTS "job_attempt" CASCADE;
DROP TABLE IF EXISTS "job_step" CASCADE;
DROP TABLE IF EXISTS "provisioning_job" CASCADE;
DROP TABLE IF EXISTS "provider_account" CASCADE;
DROP TABLE IF EXISTS "provider" CASCADE;
DROP TABLE IF EXISTS "business_identity" CASCADE;
