-- VTID-05023 part 10 — neutralize the Aurora REHEARSAL CLONE before the staging gateway points at it.
--
-- The clone is a byte copy of vitana-aurora-prod, so it carries production's queues and member
-- device tokens. Two staging-gateway loops have no off switch (docs/validation/VTID-05023/rehearsal.md,
-- "Needs a switch"); this file takes away what they could act on, on the CLONE only:
--   1. every FCM device token is marked revoked, so no push path on the clone can reach a real device;
--   2. every lifecycle notification still waiting is marked notified, so the lifecycle worker
--      (no off switch) finds nothing to send.
--
-- Every statement checks, inside the database, that it runs on the rehearsal clone's writer
-- (aurora_db_instance_identifier(), an Aurora PostgreSQL built-in) and raises otherwise, so the
-- file is inert if it is ever pointed at vitana-aurora-prod by mistake. Run it only with
--   scripts/aws/rehearsal-clone.sh sql scripts/aws/rehearsal-clone-neutralize.sql
-- One statement per line (the runner's contract). Idempotent.
DO $$ BEGIN IF aurora_db_instance_identifier() NOT LIKE 'vitana-aurora-rehearsal%' THEN RAISE EXCEPTION 'refusing: % is not the rehearsal clone', aurora_db_instance_identifier(); END IF; IF to_regclass('public.user_device_tokens') IS NOT NULL THEN UPDATE public.user_device_tokens SET revoked_at = now() WHERE revoked_at IS NULL; END IF; END $$;
DO $$ BEGIN IF aurora_db_instance_identifier() NOT LIKE 'vitana-aurora-rehearsal%' THEN RAISE EXCEPTION 'refusing: % is not the rehearsal clone', aurora_db_instance_identifier(); END IF; IF to_regclass('public.lifecycle_notification_state') IS NOT NULL THEN UPDATE public.lifecycle_notification_state SET notified_at = now() WHERE notified_at IS NULL; END IF; END $$;
