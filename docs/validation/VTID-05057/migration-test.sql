-- VTID-05057: runs the migration against a throwaway local Postgres with a
-- minimal copy of the tables it touches, then asserts its behaviour.
-- Never point this at a shared database. Usage:
--   psql -v ON_ERROR_STOP=1 -h <local socket> -U postgres -f migration-test.sql
-- (\i path below is relative to the repo root; run from there.)

DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public; CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, phone text, phone_confirmed_at timestamptz);
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, phone text, display_name text, avatar_url text);
CREATE TABLE public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, contact_user_id uuid,
  contact_phone text, is_on_platform boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT unique_user_contact UNIQUE (user_id, contact_user_id));
CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY);
CREATE TABLE public.notification_test_actors (user_id uuid PRIMARY KEY);

-- The pre-migration matcher (20251010130129), to prove the rewrite replaces it.
CREATE FUNCTION public.match_existing_contacts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE public.contacts SET contact_user_id = NEW.user_id, is_on_platform = true
 WHERE contact_phone = NEW.phone AND contact_user_id IS NULL; RETURN NEW; END $$;
CREATE TRIGGER on_phone_verified AFTER UPDATE ON public.profiles FOR EACH ROW
  WHEN (OLD.phone IS DISTINCT FROM NEW.phone AND NEW.phone IS NOT NULL)
  EXECUTE FUNCTION public.match_existing_contacts();

-- Fixture: A already confirmed in auth before the migration; B, C, BOT, T later.
INSERT INTO auth.users VALUES ('a0000000-0000-0000-0000-00000000000a', '491701111111', now());
INSERT INTO profiles (user_id) VALUES ('a0000000-0000-0000-0000-00000000000a'),
  ('b0000000-0000-0000-0000-00000000000b'), ('c0000000-0000-0000-0000-00000000000c'),
  ('d0000000-0000-0000-0000-00000000000d'), ('e0000000-0000-0000-0000-00000000000e'),
  ('f0000000-0000-0000-0000-00000000000f');
INSERT INTO service_bot_accounts VALUES ('d0000000-0000-0000-0000-00000000000d');
INSERT INTO notification_test_actors VALUES ('e0000000-0000-0000-0000-00000000000e');

\i supabase/migrations/20261010160000_vtid_05057_contacts_phone_matching.sql

DO $$ BEGIN
  -- the backfill picked up the member auth had already confirmed
  ASSERT (SELECT phone_verified AND phone_e164 = '+491701111111' FROM profiles WHERE user_id = 'a0000000-0000-0000-0000-00000000000a'), 'backfill';
  ASSERT (SELECT NOT phone_verified AND discoverable_by_phone FROM profiles WHERE user_id = 'b0000000-0000-0000-0000-00000000000b'), 'defaults';
END $$;

-- Owner F has B's and C's numbers (two rows with B's number), plus a typed-only number.
INSERT INTO contacts (user_id, contact_phone, contact_phone_e164, created_at) VALUES
  ('f0000000-0000-0000-0000-00000000000f', '0170 2222222', '{+491702222222}', now() - interval '2 min'),
  ('f0000000-0000-0000-0000-00000000000f', '+49 170 2222222', '{+491702222222}', now() - interval '1 min'),
  ('f0000000-0000-0000-0000-00000000000f', '0170 3333333', '{+491703333333}', now()),
  ('f0000000-0000-0000-0000-00000000000f', '0170 4444444', '{+491704444444}', now()),
  ('f0000000-0000-0000-0000-00000000000f', '0170 5555555', '{+491705555555}', now());

-- 1. A number typed into a profile, never confirmed: no match (the old trigger matched this).
UPDATE profiles SET phone = '0170 3333333' WHERE user_id = 'c0000000-0000-0000-0000-00000000000c';
DO $$ BEGIN ASSERT (SELECT count(*) FROM contacts WHERE contact_user_id IS NOT NULL) = 0, 'typed phone must not match'; END $$;

-- 2. Auth confirms B: exactly one of F's two rows links, no unique violation.
INSERT INTO auth.users VALUES ('b0000000-0000-0000-0000-00000000000b', '491702222222', NULL);
DO $$ BEGIN ASSERT (SELECT NOT phone_verified FROM profiles WHERE user_id = 'b0000000-0000-0000-0000-00000000000b'), 'unconfirmed insert'; END $$;
UPDATE auth.users SET phone_confirmed_at = now() WHERE id = 'b0000000-0000-0000-0000-00000000000b';
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM contacts WHERE contact_user_id = 'b0000000-0000-0000-0000-00000000000b') = 1, 'one row per address book';
  ASSERT (SELECT is_on_platform FROM contacts WHERE contact_user_id = 'b0000000-0000-0000-0000-00000000000b'), 'is_on_platform';
END $$;

-- 3. A member who opted out of discovery is not linked; opting back in links.
UPDATE profiles SET discoverable_by_phone = false WHERE user_id = 'c0000000-0000-0000-0000-00000000000c';
INSERT INTO auth.users VALUES ('c0000000-0000-0000-0000-00000000000c', '491703333333', now());
DO $$ BEGIN ASSERT (SELECT count(*) FROM contacts WHERE contact_user_id = 'c0000000-0000-0000-0000-00000000000c') = 0, 'opt-out'; END $$;
UPDATE profiles SET discoverable_by_phone = true WHERE user_id = 'c0000000-0000-0000-0000-00000000000c';
DO $$ BEGIN ASSERT (SELECT count(*) FROM contacts WHERE contact_user_id = 'c0000000-0000-0000-0000-00000000000c') = 1, 'opt back in'; END $$;

-- 4. Service and test accounts are never linked.
INSERT INTO auth.users VALUES ('d0000000-0000-0000-0000-00000000000d', '491704444444', now()),
                              ('e0000000-0000-0000-0000-00000000000e', '491705555555', now());
DO $$ BEGIN ASSERT (SELECT count(*) FROM contacts WHERE contact_user_id IN
  ('d0000000-0000-0000-0000-00000000000d', 'e0000000-0000-0000-0000-00000000000e')) = 0, 'excluded accounts'; END $$;

-- 5. Losing confirmation clears the mirror.
UPDATE auth.users SET phone_confirmed_at = NULL WHERE id = 'c0000000-0000-0000-0000-00000000000c';
DO $$ BEGIN ASSERT (SELECT NOT phone_verified AND phone_e164 IS NULL FROM profiles WHERE user_id = 'c0000000-0000-0000-0000-00000000000c'), 'unconfirm'; END $$;

-- 6. Point lookup: international forms only, verified + discoverable only.
DO $$ BEGIN
  ASSERT (SELECT user_id FROM check_phone_on_platform('+49 170 2222222')) = 'b0000000-0000-0000-0000-00000000000b', 'lookup +';
  ASSERT (SELECT user_id FROM check_phone_on_platform('0049 170 2222222')) = 'b0000000-0000-0000-0000-00000000000b', 'lookup 00';
  ASSERT (SELECT count(*) FROM check_phone_on_platform('0170 2222222')) = 0, 'national form';
  ASSERT (SELECT count(*) FROM check_phone_on_platform('+49 170 3333333')) = 0, 'unverified';
  ASSERT (SELECT count(*) FROM check_phone_on_platform('+49 170 4444444')) = 0, 'service account';
END $$;

-- 7. Re-running the migration is safe (IF NOT EXISTS / OR REPLACE).
\i supabase/migrations/20261010160000_vtid_05057_contacts_phone_matching.sql

SELECT 'VTID-05057 migration test: all assertions passed' AS result;
