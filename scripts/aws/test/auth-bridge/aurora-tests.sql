-- VTID-05023 part 4, "aurora" database: the lazy db-pre-request hook driven
-- the way PostgREST drives it (SET LOCAL ROLE + request.jwt.claims, then
-- SELECT pre_request(), then the request in the same transaction; GET runs in
-- a READ ONLY transaction), the grants, and the deletion path.

-- A member-owned table with RLS and a foreign key to app_users, like the 20
-- Aurora FKs onto app_users (aurora-cutover-recreate-foreign-keys.sql).
CREATE TABLE public.diary_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  body text NOT NULL);
ALTER TABLE public.diary_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY diary_own ON public.diary_entries FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO anon, authenticated USING (true);

-- ── 1. GET (read-only transaction) by an unprovisioned member: no-op, read works
BEGIN READ ONLY;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000005","role":"authenticated","email":"erin@example.com","user_metadata":{"full_name":"Erin E"}}', true);
SELECT public.provisioning_pre_request();
SELECT count(*) AS visible_profiles FROM public.profiles;
SELECT count(*) AS own_diary_entries FROM public.diary_entries;
COMMIT;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.app_users WHERE user_id = '10000000-0000-0000-0000-000000000005')
     OR EXISTS (SELECT 1 FROM public.profiles WHERE user_id = '10000000-0000-0000-0000-000000000005') THEN
    RAISE EXCEPTION 'FAIL: the hook provisioned inside a read-only transaction';
  END IF;
  RAISE NOTICE 'ok: read-only request by an unprovisioned member succeeded, hook was a no-op';
END $$;

-- ── 2. Null uid (anon) and service_role (no sub) in a read-write transaction: no-op
BEGIN;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT public.provisioning_pre_request();
COMMIT;
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT public.provisioning_pre_request();
COMMIT;
BEGIN;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '', true);
SELECT public.provisioning_pre_request();
COMMIT;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.app_users) <> 4 THEN
    RAISE EXCEPTION 'FAIL: a null-uid request provisioned someone';
  END IF;
  RAISE NOTICE 'ok: null uid / service_role requests are a no-op';
END $$;

-- ── 3. Negative control: without the hook, an unprovisioned member's first write hits the FK
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000006","role":"authenticated","email":"frank@example.com"}', true);
  BEGIN
    INSERT INTO public.diary_entries (user_id, body) VALUES ('10000000-0000-0000-0000-000000000006', 'too early');
    RAISE EXCEPTION 'FAIL: write without provisioning should have hit the app_users FK';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'ok: without the hook the first write fails on the app_users FK (the race the hook closes)';
  END;
END $$;
RESET ROLE;

-- ── 4. Write by an unprovisioned member: the hook provisions first, the write succeeds
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000005","role":"authenticated","email":"erin@example.com","user_metadata":{"full_name":"Erin E","tenant_slug":"maxina"}}', true);
SELECT public.provisioning_pre_request();
INSERT INTO public.diary_entries (user_id, body) VALUES ('10000000-0000-0000-0000-000000000005', 'first entry');
COMMIT;
DO $$
DECLARE u constant uuid := '10000000-0000-0000-0000-000000000005';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_users WHERE user_id = u AND email = 'erin@example.com' AND display_name = 'Erin E' AND tenant_id = '00000000-0000-0000-0000-0000000000a2') THEN RAISE EXCEPTION 'FAIL: app_users not provisioned by the hook'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = u AND full_name = 'Erin E') THEN RAISE EXCEPTION 'FAIL: profile not provisioned by the hook'; END IF;
  IF (SELECT count(*) FROM public.wallet_accounts WHERE user_id = u) <> 2 THEN RAISE EXCEPTION 'FAIL: wallets not provisioned by the hook'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_tenants WHERE user_id = u AND is_primary) THEN RAISE EXCEPTION 'FAIL: tenant membership not provisioned by the hook'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_discount_codes WHERE user_id = u) THEN RAISE EXCEPTION 'FAIL: maxina discount code not provisioned by the hook'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.diary_entries WHERE user_id = u) THEN RAISE EXCEPTION 'FAIL: the member''s write did not land'; END IF;
  RAISE NOTICE 'ok: write by an unprovisioned member succeeds after the hook provisions';
END $$;

-- ── 5. A provisioned member's write: the hook does one indexed lookup and nothing else
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000005","role":"authenticated","email":"erin@example.com","user_metadata":{"tenant_slug":"alkalma"}}', true);
SELECT public.provisioning_pre_request();
INSERT INTO public.diary_entries (user_id, body) VALUES ('10000000-0000-0000-0000-000000000005', 'second entry');
COMMIT;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.user_tenants WHERE user_id = '10000000-0000-0000-0000-000000000005' AND tenant_id = '00000000-0000-0000-0000-0000000000a3') THEN
    RAISE EXCEPTION 'FAIL: edited user_metadata added a tenant membership to a provisioned member';
  END IF;
  RAISE NOTICE 'ok: provisioned member untouched by the hook';
END $$;

-- ── 6. Registered test/service accounts are never provisioned by the hook (rules 43-45)
INSERT INTO public.service_bot_accounts VALUES ('10000000-0000-0000-0000-000000000007', 'bot', 'automation identity');
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000007","role":"authenticated","email":"bot@example.com"}', true);
SELECT public.provisioning_pre_request();
COMMIT;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.app_users WHERE user_id = '10000000-0000-0000-0000-000000000007') THEN
    RAISE EXCEPTION 'FAIL: hook provisioned a registered service account';
  END IF;
  IF EXISTS (SELECT 1 FROM public.auth_bridge_unprovisioned(ARRAY['10000000-0000-0000-0000-000000000007'::uuid])) THEN
    RAISE EXCEPTION 'FAIL: auth_bridge_unprovisioned lists a registered service account';
  END IF;
  IF (SELECT count(*) FROM public.auth_bridge_unprovisioned(ARRAY['10000000-0000-0000-0000-000000000001'::uuid, '10000000-0000-0000-0000-000000000009'::uuid])) <> 1 THEN
    RAISE EXCEPTION 'FAIL: auth_bridge_unprovisioned should list exactly the unknown user';
  END IF;
  RAISE NOTICE 'ok: service accounts skipped; auth_bridge_unprovisioned lists only real missing users';
END $$;

-- ── 7. A provisioning failure never fails the member's request (webhook/reconciler retry)
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000008","role":"authenticated","email":"alice@example.com"}', true);
SELECT public.provisioning_pre_request();
SELECT count(*) AS still_readable FROM public.profiles;
COMMIT;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles WHERE user_id = '10000000-0000-0000-0000-000000000008') THEN
    RAISE EXCEPTION 'FAIL: a failed provisioning left partial rows';
  END IF;
  RAISE NOTICE 'ok: failed provisioning (duplicate email) rolled back to a savepoint, request continued';
END $$;

-- ── 8. Partial provisioning (an app_users row from the gateway''s old /me net) is completed
INSERT INTO public.app_users (user_id, email, display_name) VALUES ('10000000-0000-0000-0000-00000000000a', 'gina@example.com', 'gina');
SET ROLE service_role;
DO $$
DECLARE r jsonb;
BEGIN
  r := public.ensure_provisioned('10000000-0000-0000-0000-00000000000a', 'gina@example.com', '{}', NULL);
  IF NOT (r -> 'created') ? 'profiles' OR (r -> 'created') ? 'app_users' THEN
    RAISE EXCEPTION 'FAIL: partial provisioning not completed as expected: %', r;
  END IF;
  RAISE NOTICE 'ok: partial provisioning completed, existing app_users row kept';
END $$;
RESET ROLE;

-- ── 9. Grants: members cannot call the provisioning or deletion functions directly
SET ROLE authenticated;
DO $$ BEGIN
  BEGIN
    PERFORM public.ensure_provisioned('10000000-0000-0000-0000-00000000000b', 'x@example.com', '{}', NULL);
    RAISE EXCEPTION 'FAIL: authenticated can execute ensure_provisioned';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.auth_bridge_handle_deleted_user('10000000-0000-0000-0000-000000000001', 'x');
    RAISE EXCEPTION 'FAIL: authenticated can execute auth_bridge_handle_deleted_user';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.auth_user_fk_map;
    RAISE EXCEPTION 'FAIL: authenticated can read auth_user_fk_map';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: ensure_provisioned / deletion / fk map are service_role only';
END $$;
RESET ROLE;

-- ── 10. Deletion: what DELETE FROM auth.users did through the public->auth FKs
CREATE TABLE public.contacts (
  id serial PRIMARY KEY, owner_user_id uuid NOT NULL, contact_user_id uuid, contact_phone text,
  CONSTRAINT contact_identifier_required CHECK (contact_phone IS NOT NULL OR contact_user_id IS NOT NULL));
CREATE TABLE public.fk_a_parent (id serial PRIMARY KEY, user_id uuid NOT NULL);
CREATE TABLE public.fk_b_child (id serial PRIMARY KEY, user_id uuid NOT NULL, parent_id int NOT NULL REFERENCES public.fk_a_parent(id));
CREATE TABLE public.restricted_things (id serial PRIMARY KEY, user_id uuid NOT NULL);
INSERT INTO public.contacts (owner_user_id, contact_user_id, contact_phone) VALUES
  ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', NULL),
  ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '+491234'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', NULL);
INSERT INTO public.fk_a_parent (id, user_id) VALUES (1, '10000000-0000-0000-0000-000000000001'), (2, '10000000-0000-0000-0000-000000000002');
INSERT INTO public.fk_b_child (user_id, parent_id) VALUES ('10000000-0000-0000-0000-000000000001', 1), ('10000000-0000-0000-0000-000000000002', 2);
INSERT INTO public.restricted_things (user_id) VALUES ('10000000-0000-0000-0000-000000000001');

SET ROLE service_role;
DO $$ BEGIN
  BEGIN
    PERFORM public.auth_bridge_handle_deleted_user('10000000-0000-0000-0000-000000000001', 'webhook');
    RAISE EXCEPTION 'FAIL: deletion ran with an empty FK map';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%auth_user_fk_map is empty%' THEN RAISE; END IF;
    RAISE NOTICE 'ok: deletion refuses to run with an empty FK map';
  END;
END $$;
RESET ROLE;

-- The map as scripts/aws/supabase-auth-fk-map-export.sql would load it.
INSERT INTO public.auth_user_fk_map (table_name, column_name, on_delete) VALUES
  ('profiles', 'user_id', 'c'), ('contacts', 'contact_user_id', 'n'),
  ('fk_a_parent', 'user_id', 'c'), ('fk_b_child', 'user_id', 'c'),
  ('restricted_things', 'user_id', 'a'), ('table_dropped_since_export', 'user_id', 'c');

SET ROLE service_role;
CREATE TEMP TABLE del_result AS SELECT public.auth_bridge_handle_deleted_user('10000000-0000-0000-0000-000000000001', 'webhook') AS r;
RESET ROLE;
DO $$
DECLARE
  r jsonb := (SELECT d.r FROM del_result d);
  a constant uuid := '10000000-0000-0000-0000-000000000001';
BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles WHERE user_id = a) THEN RAISE EXCEPTION 'FAIL: CASCADE table row left: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = '10000000-0000-0000-0000-000000000002') THEN RAISE EXCEPTION 'FAIL: another member''s profile was deleted'; END IF;
  IF EXISTS (SELECT 1 FROM public.contacts WHERE contact_user_id = a) THEN RAISE EXCEPTION 'FAIL: contacts still reference the deleted user'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contacts WHERE contact_phone = '+491234' AND contact_user_id IS NULL) THEN RAISE EXCEPTION 'FAIL: phone contact should survive with contact_user_id NULL'; END IF;
  IF (SELECT count(*) FROM public.contacts) <> 2 THEN RAISE EXCEPTION 'FAIL: phoneless inbound contact not removed (or too much removed)'; END IF;
  IF EXISTS (SELECT 1 FROM public.fk_a_parent WHERE user_id = a) OR EXISTS (SELECT 1 FROM public.fk_b_child WHERE user_id = a) THEN RAISE EXCEPTION 'FAIL: FK-ordered tables not cleaned: %', r; END IF;
  IF (SELECT count(*) FROM public.fk_b_child) <> 1 THEN RAISE EXCEPTION 'FAIL: other member''s child row touched'; END IF;
  IF (r ->> 'passes')::int <> 2 THEN RAISE EXCEPTION 'FAIL: expected a second pass for the FK-ordered tables: %', r; END IF;
  IF (r -> 'blocked' ->> 'restricted_things.user_id')::int <> 1 OR NOT EXISTS (SELECT 1 FROM public.restricted_things WHERE user_id = a) THEN RAISE EXCEPTION 'FAIL: NO ACTION table must be reported, not touched: %', r; END IF;
  IF (r ->> 'contacts_deleted')::int <> 1 THEN RAISE EXCEPTION 'FAIL: contacts cleanup count: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_users WHERE user_id = a) THEN RAISE EXCEPTION 'FAIL: app_users has no FK to auth.users; the old flow kept it'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.auth_bridge_deleted_users WHERE user_id = a AND source = 'webhook') THEN RAISE EXCEPTION 'FAIL: deletion not recorded'; END IF;
  RAISE NOTICE 'ok: deletion applied CASCADE / SET NULL / contacts cleanup, reported NO ACTION, kept app_users: %', r;
END $$;

SET ROLE service_role;
DO $$
DECLARE r jsonb;
BEGIN
  r := public.auth_bridge_handle_deleted_user('10000000-0000-0000-0000-000000000001', 'reconciler');
  IF r -> 'affected' <> '{}'::jsonb OR (r ->> 'contacts_deleted')::int <> 0 THEN
    RAISE EXCEPTION 'FAIL: repeat deletion changed rows: %', r;
  END IF;
  RAISE NOTICE 'ok: deletion is idempotent';
END $$;
RESET ROLE;

-- ── 11. erase_user_data (VTID-04765) runs on Aurora, where auth.users does not exist
CREATE TABLE public.erasure_registry (table_name text PRIMARY KEY, action text NOT NULL, reason text NOT NULL);
INSERT INTO public.erasure_registry VALUES ('wallet_accounts', 'retain', 'test: statutory retention');
INSERT INTO public.diary_entries (user_id, body) VALUES ('10000000-0000-0000-0000-000000000002', 'b''s entry');
DO $$ BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN RAISE EXCEPTION 'FAIL: the aurora test db must have no auth.users'; END IF;
END $$;
BEGIN;
DELETE FROM public.auth_user_fk_map;
SET LOCAL ROLE service_role;
DO $$ BEGIN
  BEGIN
    PERFORM public.erase_user_data('10000000-0000-0000-0000-000000000002', true);
    RAISE EXCEPTION 'FAIL: erase ran with an empty FK map';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%auth_user_fk_map is empty%' THEN RAISE; END IF;
    RAISE NOTICE 'ok: erase refuses to run with an empty FK map';
  END;
END $$;
ROLLBACK;
SET ROLE authenticated;
DO $$ BEGIN
  BEGIN
    PERFORM public.erase_user_data('10000000-0000-0000-0000-000000000002', true);
    RAISE EXCEPTION 'FAIL: a member could call erase_user_data';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: members cannot call erase_user_data';
  END;
END $$;
RESET ROLE;
SET ROLE service_role;
DO $$
DECLARE
  r jsonb;
  b constant uuid := '10000000-0000-0000-0000-000000000002';
BEGIN
  r := public.erase_user_data(b, true);
  IF (r -> 'deleted' ->> 'diary_entries')::int <> 1 OR NOT EXISTS (SELECT 1 FROM public.diary_entries WHERE user_id = b) THEN
    RAISE EXCEPTION 'FAIL: dry run must count, not delete: %', r;
  END IF;
  r := public.erase_user_data(b);
  IF r -> 'errors' <> '{}'::jsonb THEN RAISE EXCEPTION 'FAIL: erase reported errors: %', r; END IF;
  IF EXISTS (SELECT 1 FROM public.diary_entries WHERE user_id = b) OR EXISTS (SELECT 1 FROM public.user_preferences WHERE user_id = b)
     OR EXISTS (SELECT 1 FROM public.app_users WHERE user_id = b) THEN RAISE EXCEPTION 'FAIL: member rows left: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wallet_accounts WHERE user_id = b) THEN RAISE EXCEPTION 'FAIL: retained table erased: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = b) OR NOT EXISTS (SELECT 1 FROM public.fk_a_parent WHERE user_id = b) THEN
    RAISE EXCEPTION 'FAIL: tables that cascade from auth.users must be left to the deletion handler: %', r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_preferences WHERE user_id = '10000000-0000-0000-0000-000000000003') THEN RAISE EXCEPTION 'FAIL: another member''s rows erased'; END IF;
  RAISE NOTICE 'ok: erase_user_data on Aurora erased the member''s rows, kept retained and auth-cascade tables: %', r;
END $$;
RESET ROLE;
