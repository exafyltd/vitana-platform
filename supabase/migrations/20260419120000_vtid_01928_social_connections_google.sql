-- VTID-01928: Allow `google` in social_connections.provider
--
-- The original CHECK constraint (VTID-01250) only permitted the six social
-- providers (instagram/facebook/tiktok/youtube/linkedin/twitter). Google OAuth
-- for Gmail / Calendar / Contacts / YouTube / YouTube Music reuses the same
-- social-connect storage path but stores its token row under provider='google',
-- so the CHECK needs to be widened.
--
-- Idempotent: looks up the existing constraint by name OR by predicate text,
-- drops whichever is found, then re-adds the widened version.

DO $$
DECLARE
  existing_name TEXT;
BEGIN
  SELECT conname
    INTO existing_name
    FROM pg_constraint
   WHERE conrelid = 'public.social_connections'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%provider%IN%'
   LIMIT 1;

  IF existing_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.social_connections DROP CONSTRAINT %I',
      existing_name
    );
  END IF;
END $$;

ALTER TABLE public.social_connections
  ADD CONSTRAINT social_connections_provider_check
  CHECK (provider IN (
    'instagram', 'facebook', 'tiktok', 'youtube', 'linkedin', 'twitter',
    'google'
  ));

COMMENT ON CONSTRAINT social_connections_provider_check ON public.social_connections
  IS 'VTID-01928: adds google alongside the original six providers';
