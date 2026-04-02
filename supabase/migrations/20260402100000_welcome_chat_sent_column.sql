-- Add welcome_chat_sent flag to app_users
-- Used by the Welcome Chat Service to track whether a new user's
-- introduction messages have been sent to all community members.
-- Idempotent: column added only if it does not already exist.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'app_users'
      AND column_name = 'welcome_chat_sent'
  ) THEN
    ALTER TABLE public.app_users
      ADD COLUMN welcome_chat_sent BOOLEAN NOT NULL DEFAULT false;

    COMMENT ON COLUMN public.app_users.welcome_chat_sent
      IS 'Whether automated welcome chat messages have been sent from this user to all community members';
  END IF;
END
$$;
