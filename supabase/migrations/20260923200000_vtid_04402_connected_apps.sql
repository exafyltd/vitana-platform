-- VTID-04402 — Connected Apps hub (with VTID-04403 Microsoft, VTID-04404
-- Apple iCloud, VTID-04405 contacts import).
--
-- The nine mail / calendar / contacts apps on the Connected Apps screen get
-- one toggle each. What this migration adds:
--
--   1. social_connections.provider may be 'microsoft' (Outlook Mail +
--      Outlook Calendar share one Microsoft Graph token, like the Google apps
--      share one Google token).
--   2. connected_app_settings — the toggle itself, per member and app, plus
--      the last sync result. A token alone does not mean an app is on: a
--      member can turn Gmail off and keep Google Calendar.
--   3. apple_account_credentials — Apple has no OAuth for iCloud mail,
--      calendar or contacts; a member signs in with an app-specific password.
--      Stored AES-256-GCM encrypted (lib/ai-credential-crypto.ts), never in
--      plaintext, never readable by the browser.
--   4. contacts.source / contacts.external_id — imported contacts are
--      de-duplicated per source, so a second sync updates instead of adding.
--   5. calendar_external_busy.source may be 'microsoft' or 'apple' — busy
--      times from Outlook and iCloud calendars show as grey blocks too.
--
-- New tables are service-role only: RLS on, no policies, no grants.

-- 1 ---------------------------------------------------------------------------
ALTER TABLE public.social_connections DROP CONSTRAINT IF EXISTS social_connections_provider_check;
ALTER TABLE public.social_connections ADD CONSTRAINT social_connections_provider_check
  CHECK (provider = ANY (ARRAY['instagram','facebook','tiktok','youtube','linkedin','twitter','google','microsoft']));

-- 2 ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.connected_app_settings (
  user_id      uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  app_id       text NOT NULL CHECK (app_id IN (
                 'gmail','google-calendar','google-contacts',
                 'outlook-mail','outlook-calendar',
                 'apple-mail','apple-calendar','iphone-contacts',
                 'android-contacts')),
  enabled      boolean NOT NULL DEFAULT false,
  last_sync_at timestamptz,
  last_result  jsonb,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, app_id)
);

COMMENT ON TABLE public.connected_app_settings IS
  'VTID-04402: per-member on/off state of each Connected App (mail / calendar / contacts) and its last sync result. Service role only.';

-- 3 ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.apple_account_credentials (
  user_id           uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  tenant_id         uuid,
  apple_id          text NOT NULL,
  secret_ciphertext bytea NOT NULL,
  secret_iv         bytea NOT NULL,
  secret_tag        bytea NOT NULL,
  caldav_home_url   text,
  carddav_home_url  text,
  verified_at       timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.apple_account_credentials IS
  'VTID-04404: a member''s Apple ID and app-specific password (AES-256-GCM encrypted) for iCloud CalDAV / CardDAV / IMAP. Service role only; deleted when the last Apple app is turned off.';

-- 4 ---------------------------------------------------------------------------
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS external_id text;

-- Not partial: PostgREST upserts (on_conflict=user_id,source,external_id)
-- need a plain unique index. Hand-added contacts keep source/external_id
-- NULL, and NULLs never collide, so they are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_user_source_external_uidx
  ON public.contacts (user_id, source, external_id);

COMMENT ON COLUMN public.contacts.source IS
  'VTID-04405: where an imported contact came from (google, microsoft, icloud, android). NULL for contacts added by hand.';
COMMENT ON COLUMN public.contacts.external_id IS
  'VTID-04405: the contact''s id at its source; with user_id + source it de-duplicates re-imports.';

-- 5 ---------------------------------------------------------------------------
ALTER TABLE public.calendar_external_busy DROP CONSTRAINT IF EXISTS calendar_external_busy_source_check;
ALTER TABLE public.calendar_external_busy ADD CONSTRAINT calendar_external_busy_source_check
  CHECK (source IN ('google','microsoft','apple'));

ALTER TABLE public.connected_app_settings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apple_account_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.connected_app_settings    FROM anon, authenticated;
REVOKE ALL ON public.apple_account_credentials FROM anon, authenticated;
