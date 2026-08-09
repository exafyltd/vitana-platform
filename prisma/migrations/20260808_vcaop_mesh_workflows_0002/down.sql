-- DOWN / rollback for 20260808_vcaop_mesh_workflows_0002 (VTID-03537).
-- Drops only the 7 workflow tables; every pre-existing table untouched.
-- Verified up->down->up on ephemeral Postgres 16.
DROP TABLE IF EXISTS "dead_letter_event" CASCADE;
DROP TABLE IF EXISTS "workflow_step" CASCADE;
DROP TABLE IF EXISTS "workflow_run" CASCADE;
DROP TABLE IF EXISTS "workflow_version" CASCADE;
DROP TABLE IF EXISTS "workflow_definition" CASCADE;
DROP TABLE IF EXISTS "normalized_event" CASCADE;
DROP TABLE IF EXISTS "event_subscription" CASCADE;
