-- VTID-05782 (plan autonomous-to-staging-r2, design.md §5): the isolated staging database must never call production.
-- A migration that hard-codes a production endpoint in a function body is replaced here by a no-op with the same
-- signature (the schema hash covers signatures, not bodies, so the hash is unchanged). build-schema.mjs checks after
-- this seed that no function body, column default or view definition still names a production identifier, and
-- infra/staging-db/bundle-prod-ref-allow.json points at this file for each neutralized occurrence.

-- 20261012235118_vtid_05118_welcome_discount_trigger_secret.sql: the welcome-discount e-mail trigger posts to the
-- production edge function. Staging sends no e-mail.
CREATE OR REPLACE FUNCTION public.notify_welcome_discount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_welcome_discount() FROM PUBLIC, anon, authenticated;
