-- VTID-05029: email backstop for important notifications a push never reached.
--
-- When a push-eligible notification's recorded outcome (VTID-04962) is
-- no_device or fcm_error and the member has not read it in-app within an
-- hour, the gateway sends one digest email per member (at most one per six
-- hours). This migration adds the bookkeeping the job needs:
--
--   user_notifications.email_fallback_sent_at   — the row was included in a
--     digest that Resend accepted. NULL = not emailed.
--   user_notification_preferences.email_fallback_enabled — the member's own
--     opt-out. There was no email preference before; default true, and
--     push_enabled = false stays a full opt-out (no email either).
--
-- Additive and idempotent: nullable column / column with a constant default
-- (no table rewrite), no backfill. The job itself ships inert: it only runs on
-- production with EMAIL_FALLBACK_ENABLED=true and Resend configured.

BEGIN;

ALTER TABLE public.user_notifications
  ADD COLUMN IF NOT EXISTS email_fallback_sent_at timestamptz;

ALTER TABLE public.user_notification_preferences
  ADD COLUMN IF NOT EXISTS email_fallback_enabled boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_user_notifications_email_fallback_pending
  ON public.user_notifications (created_at)
  WHERE email_fallback_sent_at IS NULL
    AND read_at IS NULL
    AND push_outcome IN ('no_device', 'fcm_error');

CREATE INDEX IF NOT EXISTS idx_user_notifications_email_fallback_sent
  ON public.user_notifications (user_id, email_fallback_sent_at DESC)
  WHERE email_fallback_sent_at IS NOT NULL;

COMMENT ON COLUMN public.user_notifications.email_fallback_sent_at IS
  'VTID-05029: when this undelivered notification was included in an accepted fallback digest email. NULL = not emailed.';
COMMENT ON COLUMN public.user_notification_preferences.email_fallback_enabled IS
  'VTID-05029: member opt-out for the fallback digest email (default true; push_enabled=false also suppresses it).';

COMMIT;
