-- VTID-05137 rollback (by hand, owner's go only). Code first: set
-- CHAT_PUSH_COALESCING_ENABLED=false (or deploy the code revert) so nothing
-- writes 'coalesced' any more, then re-map existing rows and restore the CHECK.
BEGIN;
UPDATE public.user_notifications SET push_outcome = NULL WHERE push_outcome = 'coalesced';
ALTER TABLE public.user_notifications DROP CONSTRAINT IF EXISTS user_notifications_push_outcome_check;
ALTER TABLE public.user_notifications
  ADD CONSTRAINT user_notifications_push_outcome_check CHECK (
    push_outcome IS NULL OR push_outcome IN (
      'delivered_fcm','delivered_appilix','delivered_both','no_device','fcm_error',
      'suppressed_type_disabled','suppressed_push_disabled','suppressed_dnd','dispatch_exception'
    )
  ) NOT VALID;
ALTER TABLE public.user_notifications VALIDATE CONSTRAINT user_notifications_push_outcome_check;
DROP INDEX IF EXISTS public.idx_user_notifications_chat_conv;
COMMIT;
