-- VTID-05312 rollback (revert the gateway first). Rows with the two new outcomes must be relabelled before
-- the old CHECK can be validated again.
BEGIN;
UPDATE public.user_notifications SET push_outcome = 'coalesced' WHERE push_outcome IN ('suppressed_viewing', 'suppressed_duplicate');
ALTER TABLE public.user_notifications DROP CONSTRAINT IF EXISTS user_notifications_push_outcome_check;
ALTER TABLE public.user_notifications ADD CONSTRAINT user_notifications_push_outcome_check CHECK (
  push_outcome IS NULL OR push_outcome IN ('delivered_fcm','delivered_appilix','delivered_both','no_device','fcm_error',
    'suppressed_type_disabled','suppressed_push_disabled','suppressed_dnd','dispatch_exception','coalesced')) NOT VALID;
DROP TABLE IF EXISTS public.chat_viewing_presence;
COMMIT;
