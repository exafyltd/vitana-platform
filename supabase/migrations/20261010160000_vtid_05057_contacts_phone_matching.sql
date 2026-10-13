-- VTID-05057: match imported contacts to members by phone, safely.
--
-- Plan: docs/validation/VTID-05057/plan-sparring.md (sparred, owner-approved).
--
-- 1. Columns only, no table rewrite (constant defaults are metadata-only in
--    PG 11+; nothing is backfilled here):
--      contacts.contact_phone_e164  text[]  every number of the contact in E.164
--      profiles.phone_e164          text    the member's verified number in E.164
--      profiles.phone_verified      boolean true only when auth confirmed the number
--      profiles.discoverable_by_phone boolean the member lets people find them by number
-- 2. profiles.phone_verified / phone_e164 are mirrored from auth.users
--    (phone + phone_confirmed_at) by a trigger. A number a member merely typed
--    into their profile never counts: unverified numbers never match.
-- 3. The two older phone matchers are rewritten to the same rule:
--      match_existing_contacts()  (trigger on_phone_verified on profiles) used to
--        link contacts.contact_phone = profiles.phone for ANY typed number.
--      check_phone_on_platform()  (PII-enumeration risk, see
--        20260608130000_phase_c_rpc_anon_lockdown.sql) likewise.
--    Both now require a verified, discoverable number and skip test/service
--    accounts (service_bot_accounts, notification_test_actors — CLAUDE.md
--    rules 43-45).
--
-- Rollback: docs/validation/VTID-05057/rollback.down.sql restores the previous function bodies and the
-- previous trigger; the added columns are harmless to leave.

BEGIN;

ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS contact_phone_e164 text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_contacts_phone_e164 ON public.contacts USING gin (contact_phone_e164);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone_e164 text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone_verified boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS discoverable_by_phone boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_profiles_phone_e164_verified
  ON public.profiles (phone_e164) WHERE phone_verified AND phone_e164 IS NOT NULL;

COMMENT ON COLUMN public.contacts.contact_phone_e164 IS
  'VTID-05057: every phone number of this contact in E.164, normalised by the gateway importer.';
COMMENT ON COLUMN public.profiles.phone_e164 IS
  'VTID-05057: the member''s phone in E.164, set only from a confirmed auth.users phone (sync_profile_phone_verification).';
COMMENT ON COLUMN public.profiles.phone_verified IS
  'VTID-05057: true only when auth.users.phone is set and phone_confirmed_at is not null. Unverified numbers never match contacts.';
COMMENT ON COLUMN public.profiles.discoverable_by_phone IS
  'VTID-05057: the member lets people who have their number find them on Vitanaland. Settings > Privacy.';

-- ── 2. auth.users → profiles mirror ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_profile_phone_verification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  digits   text := regexp_replace(coalesce(NEW.phone, ''), '\D', '', 'g');
  verified boolean := digits <> '' AND NEW.phone_confirmed_at IS NOT NULL;
BEGIN
  UPDATE public.profiles
     SET phone_verified = verified,
         phone_e164 = CASE WHEN verified THEN '+' || digits ELSE NULL END
   WHERE user_id = NEW.id
     AND (phone_verified IS DISTINCT FROM verified
          OR phone_e164 IS DISTINCT FROM CASE WHEN verified THEN '+' || digits ELSE NULL END);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_phone_verification ON auth.users;
CREATE TRIGGER on_auth_user_phone_verification
  AFTER INSERT OR UPDATE OF phone, phone_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_phone_verification();

-- Members whose number auth already confirmed (0 rows on 2026-10-10; bounded
-- by auth.users, so this is a small, keyed update, not a table rewrite).
UPDATE public.profiles p
   SET phone_verified = true,
       phone_e164 = '+' || regexp_replace(u.phone, '\D', '', 'g')
  FROM auth.users u
 WHERE u.id = p.user_id
   AND u.phone_confirmed_at IS NOT NULL
   AND regexp_replace(coalesce(u.phone, ''), '\D', '', 'g') <> '';

-- ── 3a. Reverse matching when a member's verified number appears ──────────
CREATE OR REPLACE FUNCTION public.match_existing_contacts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT NEW.phone_verified OR NOT NEW.discoverable_by_phone OR NEW.phone_e164 IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = NEW.user_id)
     OR EXISTS (SELECT 1 FROM public.notification_test_actors WHERE user_id = NEW.user_id) THEN
    RETURN NEW;
  END IF;
  BEGIN
    -- One row per address book, and never one that already holds this member
    -- (unique_user_contact), so a profile update can never fail here.
    WITH cand AS (
      SELECT DISTINCT ON (c.user_id) c.id
        FROM public.contacts c
       WHERE NEW.phone_e164 = ANY (c.contact_phone_e164)
         AND c.contact_user_id IS NULL
         AND c.user_id <> NEW.user_id
         AND NOT EXISTS (SELECT 1 FROM public.contacts c2
                          WHERE c2.user_id = c.user_id AND c2.contact_user_id = NEW.user_id)
       ORDER BY c.user_id, c.created_at
    )
    UPDATE public.contacts
       SET contact_user_id = NEW.user_id, is_on_platform = true, updated_at = now()
     WHERE id IN (SELECT id FROM cand);
  EXCEPTION WHEN unique_violation THEN
    RAISE WARNING 'match_existing_contacts: skipped for % (%)', NEW.user_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_phone_verified ON public.profiles;
CREATE TRIGGER on_phone_verified
  AFTER UPDATE OF phone_e164, phone_verified, discoverable_by_phone ON public.profiles
  FOR EACH ROW
  WHEN (NEW.phone_verified AND NEW.discoverable_by_phone AND NEW.phone_e164 IS NOT NULL
        AND (OLD.phone_e164 IS DISTINCT FROM NEW.phone_e164
             OR OLD.phone_verified IS DISTINCT FROM NEW.phone_verified
             OR OLD.discoverable_by_phone IS DISTINCT FROM NEW.discoverable_by_phone))
  EXECUTE FUNCTION public.match_existing_contacts();

-- ── 3b. Point lookup: same rule ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_phone_on_platform(phone_number text)
RETURNS TABLE(user_id uuid, display_name text, avatar_url text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  digits text := regexp_replace(coalesce(phone_number, ''), '\D', '', 'g');
BEGIN
  -- International form only ('+…' or '00…'); a national number has no country.
  IF left(coalesce(btrim(phone_number), ''), 2) = '00' THEN
    digits := substr(digits, 3);
  ELSIF left(coalesce(btrim(phone_number), ''), 1) <> '+' THEN
    RETURN;
  END IF;
  IF length(digits) < 6 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT p.user_id, p.display_name, p.avatar_url
    FROM public.profiles p
   WHERE p.phone_e164 = '+' || digits
     AND p.phone_verified
     AND p.discoverable_by_phone
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = p.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors t WHERE t.user_id = p.user_id)
   LIMIT 1;
END;
$$;

COMMIT;
