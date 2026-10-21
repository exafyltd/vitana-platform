-- VTID-04962: record what actually happened to each push.
--
-- user_notifications.push_sent_at only says a row was HANDLED (it stops the
-- push-dispatch cron from sending it twice) and was set even when nothing was
-- delivered: an FCM credentials/permission error counted as a send, and rows
-- for members with no device token looked identical to delivered ones. The
-- gateway now writes push_outcome after each attempt (best effort, separate
-- from push_sent_at). Rows written before this, and rows written outside
-- notifyUser()/push-dispatch, stay NULL — NULL means "not recorded", never a
-- failure.
--
-- Additive and idempotent: nullable column, no default, no rewrite, no
-- backfill. The CHECK is added NOT VALID and validated separately (every
-- existing row is NULL, so the scan only takes a SHARE UPDATE EXCLUSIVE lock).

BEGIN;

ALTER TABLE public.user_notifications
  ADD COLUMN IF NOT EXISTS push_outcome text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_notifications_push_outcome_check'
       AND conrelid = 'public.user_notifications'::regclass
  ) THEN
    ALTER TABLE public.user_notifications
      ADD CONSTRAINT user_notifications_push_outcome_check CHECK (
        push_outcome IS NULL OR push_outcome IN (
          'delivered_fcm',
          'delivered_appilix',
          'delivered_both',
          'no_device',
          'fcm_error',
          'suppressed_type_disabled',
          'suppressed_push_disabled',
          'suppressed_dnd',
          'dispatch_exception'
        )
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.user_notifications
  VALIDATE CONSTRAINT user_notifications_push_outcome_check;

COMMENT ON COLUMN public.user_notifications.push_outcome IS
  'VTID-04962: delivery outcome written by the gateway after the push attempt (best effort). NULL = not recorded. push_sent_at remains the handled marker.';

COMMIT;
