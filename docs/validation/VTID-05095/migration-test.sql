-- VTID-05095: runs the migration (on top of VTID-05057's) against a throwaway
-- local Postgres with a minimal copy of the tables it touches, then asserts
-- its behaviour. Never point this at a shared database. Usage, from the repo root:
--   psql -v ON_ERROR_STOP=1 -h <local socket> -p <port> -U postgres -f docs/validation/VTID-05095/migration-test.sql

DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public; CREATE SCHEMA auth;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TABLE auth.users (id uuid PRIMARY KEY, phone text UNIQUE, phone_confirmed_at timestamptz);
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, email text, phone text, display_name text, avatar_url text);
CREATE TABLE public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, contact_user_id uuid,
  contact_phone text, contact_email text, is_on_platform boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT unique_user_contact UNIQUE (user_id, contact_user_id));
CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY);
CREATE TABLE public.notification_test_actors (user_id uuid PRIMARY KEY);
CREATE FUNCTION public.match_existing_contacts() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;

\i supabase/migrations/20261010160000_vtid_05057_contacts_phone_matching.sql
\i supabase/migrations/20261012180000_vtid_05095_phone_verification.sql
-- applied twice: must be idempotent
\i supabase/migrations/20261012180000_vtid_05095_phone_verification.sql

-- Fixture. M = the member who verifies; O1..O4 = other members' address books.
INSERT INTO auth.users (id) VALUES ('a0000000-0000-0000-0000-00000000000a');
INSERT INTO profiles (user_id, email) VALUES
  ('a0000000-0000-0000-0000-00000000000a', 'm@example.com'),
  ('b0000000-0000-0000-0000-00000000000b', 'o1@example.com'),
  ('c0000000-0000-0000-0000-00000000000c', 'o2@example.com'),
  ('d0000000-0000-0000-0000-00000000000d', 'o3@example.com'),
  ('e0000000-0000-0000-0000-00000000000e', 'o4@example.com');
-- O1: phone-only contact with M's first number
INSERT INTO contacts (user_id, contact_phone_e164) VALUES ('b0000000-0000-0000-0000-00000000000b', '{+491701111111}');
-- O2: contact with M's first number AND M's e-mail
INSERT INTO contacts (user_id, contact_phone_e164, contact_email) VALUES ('c0000000-0000-0000-0000-00000000000c', '{+491701111111}', 'M@Example.com');
-- O3: phone-only contact with M's SECOND number
INSERT INTO contacts (user_id, contact_phone_e164) VALUES ('d0000000-0000-0000-0000-00000000000d', '{+491702222222}');
-- O4: contact with a different e-mail and M's first number
INSERT INTO contacts (user_id, contact_phone_e164, contact_email) VALUES ('e0000000-0000-0000-0000-00000000000e', '{+491701111111}', 'someone@else.com');

DO $$
DECLARE
  m uuid := 'a0000000-0000-0000-0000-00000000000a';
  r text;
  c record;
BEGIN
  -- ── begin: limits and one open challenge ──────────────────────────────
  r := phone_verification_begin(m, '+491701111111', 'h1', 600, 3, 6, 5, 200);
  ASSERT r = 'ok', 'first send ok';
  r := phone_verification_begin(m, '+491701111111', 'h2', 600, 3, 6, 5, 200);
  ASSERT r = 'ok', 'second send ok';
  ASSERT (SELECT count(*) FROM phone_verification_challenges WHERE user_id = m) = 1, 'one challenge per member';
  ASSERT (SELECT code_hash FROM phone_verification_challenges WHERE user_id = m) = 'h2', 'new send replaces the code';
  r := phone_verification_begin(m, '+491701111111', 'h3', 600, 3, 6, 5, 200);
  ASSERT r = 'ok', 'third send ok';
  r := phone_verification_begin(m, '+491701111111', 'h4', 600, 3, 6, 5, 200);
  ASSERT r = 'user_hour', 'fourth send in the hour refused';
  ASSERT (SELECT code_hash FROM phone_verification_challenges WHERE user_id = m) = 'h3', 'a refused send writes nothing';
  ASSERT (SELECT count(*) FROM phone_verification_sends WHERE user_id = m) = 3, 'three sends logged';
  -- per-number and daily cap, for another member
  r := phone_verification_begin('b0000000-0000-0000-0000-00000000000b', '+491701111111', 'x', 600, 9, 9, 3, 200);
  ASSERT r = 'phone_day', 'the number already got 3 SMS today';
  r := phone_verification_begin('b0000000-0000-0000-0000-00000000000b', '+491709999999', 'x', 600, 9, 9, 9, 3);
  ASSERT r = 'daily_cap', 'daily cap reached';
  -- old send rows are purged
  INSERT INTO phone_verification_sends (user_id, phone_e164, sent_at) VALUES (m, '+1', now() - interval '8 days');
  r := phone_verification_begin('c0000000-0000-0000-0000-00000000000c', '+491703333333', 'x', 600, 9, 9, 9, 999);
  ASSERT (SELECT count(*) FROM phone_verification_sends WHERE phone_e164 = '+1') = 0, 'rows older than 7 days purged';

  -- ── confirm: attempts, exhaustion, success, consumption, expiry ───────
  SELECT * INTO c FROM phone_verification_confirm(m, 'wrong', 5);
  ASSERT c.result = 'wrong' AND c.phone_e164 IS NULL, 'wrong code';
  ASSERT (SELECT attempts FROM phone_verification_challenges WHERE user_id = m) = 1, 'attempt counted';
  SELECT * INTO c FROM phone_verification_confirm(m, 'h3', 5);
  ASSERT c.result = 'ok' AND c.phone_e164 = '+491701111111', 'right code';
  SELECT * INTO c FROM phone_verification_confirm(m, 'h3', 5);
  ASSERT c.result = 'none', 'a code works once';
  UPDATE phone_verification_challenges SET consumed_at = NULL, attempts = 0, expires_at = now() - interval '1 second' WHERE user_id = m;
  SELECT * INTO c FROM phone_verification_confirm(m, 'h3', 5);
  ASSERT c.result = 'expired', 'expired code';
  UPDATE phone_verification_challenges SET expires_at = now() + interval '10 minutes', attempts = 0 WHERE user_id = m;
  FOR i IN 1..4 LOOP PERFORM phone_verification_confirm(m, 'nope', 5); END LOOP;
  SELECT * INTO c FROM phone_verification_confirm(m, 'nope', 5);
  ASSERT c.result = 'too_many_attempts', 'fifth wrong code exhausts';
  SELECT * INTO c FROM phone_verification_confirm(m, 'h3', 5);
  ASSERT c.result = 'too_many_attempts', 'even the right code is refused after exhaustion';
  SELECT * INTO c FROM phone_verification_confirm('f0000000-0000-0000-0000-00000000000f', 'h3', 5);
  ASSERT c.result = 'none', 'no challenge';

  -- ── the full chain: auth → profile → link → withdraw → unlink ─────────
  UPDATE auth.users SET phone = '491701111111', phone_confirmed_at = now() WHERE id = m;
  ASSERT (SELECT phone_verified AND phone_e164 = '+491701111111' FROM profiles WHERE user_id = m), 'auth mirrored to profile';
  ASSERT (SELECT count(*) FROM contacts WHERE contact_user_id = m) = 3, 'O1, O2, O4 linked by the verified number';

  -- remove the number (DELETE /me/phone clears auth.users.phone)
  UPDATE auth.users SET phone = '' WHERE id = m;
  ASSERT (SELECT NOT phone_verified AND phone_e164 IS NULL FROM profiles WHERE user_id = m), 'profile unverified';
  ASSERT (SELECT contact_user_id IS NULL AND NOT is_on_platform FROM contacts WHERE user_id = 'b0000000-0000-0000-0000-00000000000b'), 'phone-only contact unlinked';
  ASSERT (SELECT contact_user_id = m FROM contacts WHERE user_id = 'c0000000-0000-0000-0000-00000000000c'), 'e-mail-linked contact kept (case-insensitive)';
  ASSERT (SELECT contact_user_id IS NULL FROM contacts WHERE user_id = 'e0000000-0000-0000-0000-00000000000e'), 'other e-mail does not keep the link';

  -- verify again, then replace the number: old links go, new links come
  UPDATE auth.users SET phone = '491701111111' WHERE id = m;
  ASSERT (SELECT count(*) FROM contacts WHERE contact_user_id = m) = 3, 'relinked';
  UPDATE auth.users SET phone = '491702222222' WHERE id = m;
  ASSERT (SELECT phone_e164 = '+491702222222' FROM profiles WHERE user_id = m), 'new number mirrored';
  ASSERT (SELECT contact_user_id IS NULL FROM contacts WHERE user_id = 'b0000000-0000-0000-0000-00000000000b'), 'old number unlinked';
  ASSERT (SELECT contact_user_id = m FROM contacts WHERE user_id = 'd0000000-0000-0000-0000-00000000000d'), 'new number linked';
  ASSERT (SELECT contact_user_id = m FROM contacts WHERE user_id = 'c0000000-0000-0000-0000-00000000000c'), 'e-mail link still kept';

  -- hide the number (discoverable off) → phone links go
  UPDATE profiles SET discoverable_by_phone = false WHERE user_id = m;
  ASSERT (SELECT contact_user_id IS NULL FROM contacts WHERE user_id = 'd0000000-0000-0000-0000-00000000000d'), 'hidden number unlinked';
  -- unrelated profile edits never fire the trigger
  UPDATE profiles SET discoverable_by_phone = true WHERE user_id = m;
  UPDATE contacts SET contact_user_id = m WHERE user_id = 'b0000000-0000-0000-0000-00000000000b';
  UPDATE profiles SET display_name = 'Mia' WHERE user_id = m;
  ASSERT (SELECT contact_user_id = m FROM contacts WHERE user_id = 'b0000000-0000-0000-0000-00000000000b'), 'a name change unlinks nothing';
END $$;

-- ── privileges: nobody but the service role touches the codes ───────────
SET ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.phone_verification_challenges; ASSERT false, 'anon read challenges';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM public.phone_verification_begin('a0000000-0000-0000-0000-00000000000a', '+1', 'x', 1, 9, 9, 9, 9); ASSERT false, 'member called begin';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM public.phone_verification_sends; ASSERT false, 'member read sends';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET ROLE service_role;
DO $$ BEGIN
  ASSERT public.phone_verification_begin('f0000000-0000-0000-0000-00000000000f', '+491704444444', 'x', 600, 9, 9, 9, 999) = 'ok', 'service role can begin';
END $$;
RESET ROLE;

SELECT 'ALL VTID-05095 MIGRATION ASSERTIONS PASSED' AS result;
