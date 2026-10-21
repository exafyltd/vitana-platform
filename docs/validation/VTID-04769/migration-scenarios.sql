-- VTID-04769 migration scenarios. Run from the repo root against a THROWAWAY local Postgres
-- (never a shared database): createdb t && psql -d t -f docs/validation/VTID-04769/migration-scenarios.sql
\set ON_ERROR_STOP on
-- Stub schema: only the columns the migration reads/writes.
DO $$ BEGIN CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE partner_organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, lifecycle_state text NOT NULL DEFAULT 'draft', owner_user_id uuid);
-- minimal stand-in for the VTID-04471 sync: legacy status 'active' => live
CREATE FUNCTION sync_stub() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'active' THEN NEW.lifecycle_state := 'live'; END IF; RETURN NEW; END $$;
CREATE TRIGGER trg_sync BEFORE UPDATE ON partner_organizations FOR EACH ROW EXECUTE FUNCTION sync_stub();
CREATE TABLE merchants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partner_organization_id uuid, owner_user_id uuid);
CREATE TABLE products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid, title text, is_active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE service_bot_accounts (user_id uuid PRIMARY KEY);
CREATE TABLE notification_test_actors (user_id uuid PRIMARY KEY);

-- Pre-existing data for the backfill:
--  org L (live) with a never-listed draft and an admin-activated product
--  org D (draft) with an admin-activated product (must be held)
--  network merchant N (no org, no owner) with an active product (untouched)
INSERT INTO partner_organizations (id, lifecycle_state, owner_user_id) VALUES
  ('00000000-0000-0000-0000-0000000000a1','live','00000000-0000-0000-0000-00000000aaa1'),
  ('00000000-0000-0000-0000-0000000000a2','draft','00000000-0000-0000-0000-00000000aaa2');
INSERT INTO merchants (id, partner_organization_id) VALUES
  ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000b3', NULL);
INSERT INTO products (id, merchant_id, title, is_active) VALUES
  ('00000000-0000-0000-0000-000000000c01','00000000-0000-0000-0000-0000000000b1','L draft', false),
  ('00000000-0000-0000-0000-000000000c02','00000000-0000-0000-0000-0000000000b1','L on', true),
  ('00000000-0000-0000-0000-000000000c03','00000000-0000-0000-0000-0000000000b2','D admin on', true),
  ('00000000-0000-0000-0000-000000000c04','00000000-0000-0000-0000-0000000000b3','network', true),
  ('00000000-0000-0000-0000-000000000c05','00000000-0000-0000-0000-0000000000b3','network off', false);

-- an existing hand merchant whose owner owns one live org with no merchant
INSERT INTO partner_organizations (id, lifecycle_state, owner_user_id) VALUES ('00000000-0000-0000-0000-0000000000a6','live','00000000-0000-0000-0000-00000000aaa6');
INSERT INTO merchants (id, owner_user_id) VALUES ('00000000-0000-0000-0000-0000000000ba','00000000-0000-0000-0000-00000000aaa6');
INSERT INTO products (id, merchant_id, title, is_active) VALUES ('00000000-0000-0000-0000-000000000c14','00000000-0000-0000-0000-0000000000ba','existing hand draft', false);

\i supabase/migrations/20261001120000_vtid_04769_supplier_go_live_lists_products.sql

CREATE FUNCTION expect(p_id text, p_active boolean, p_hold text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r products%ROWTYPE; BEGIN
  SELECT * INTO r FROM products WHERE id = ('00000000-0000-0000-0000-000000000' || p_id)::uuid;
  IF r.is_active IS DISTINCT FROM p_active OR r.listing_hold IS DISTINCT FROM p_hold THEN
    RAISE EXCEPTION 'FAIL %: % active=% hold=% (want % %)', p_label, r.title, r.is_active, r.listing_hold, p_active, p_hold;
  END IF;
  RAISE NOTICE 'ok  %', p_label;
END $$;

-- 1. Backfill
SELECT expect('c01', true,  NULL, 'backfill: live org draft goes on');
SELECT expect('c02', true,  NULL, 'backfill: live org product stays on');
SELECT expect('c03', false, 'org_not_live', 'backfill: draft org admin-activated product is held');
SELECT expect('c04', true,  NULL, 'backfill: network product untouched');
SELECT expect('c05', false, NULL, 'backfill: network inactive product untouched');
SELECT expect('c14', true, NULL, 'backfill: existing hand merchant linked to its live org, draft on');

-- 2. New product while live: on at once (gateway inserts is_active=false)
INSERT INTO products (id, merchant_id, title, is_active) VALUES ('00000000-0000-0000-0000-000000000c06','00000000-0000-0000-0000-0000000000b1','L new', false);
SELECT expect('c06', true, NULL, 'insert while live: on');
-- 3. New product while draft: waits
INSERT INTO products (id, merchant_id, title, is_active) VALUES ('00000000-0000-0000-0000-000000000c07','00000000-0000-0000-0000-0000000000b2','D new', true);
SELECT expect('c07', false, NULL, 'insert while not live: off, waiting');

-- 4. Admin switches a live-org product off: stays off through pause/resume
UPDATE products SET is_active = false WHERE id = '00000000-0000-0000-0000-000000000c02';
SELECT expect('c02', false, NULL, 'admin switch-off');

-- 5. Org D activated through the legacy status path => live
UPDATE partner_organizations SET status = 'active' WHERE id = '00000000-0000-0000-0000-0000000000a2';
SELECT expect('c03', true, NULL, 'go-live: held product on');
SELECT expect('c07', true, NULL, 'go-live: waiting draft on');

-- 6. Pause org L: its on products held; admin-off one untouched
UPDATE partner_organizations SET lifecycle_state = 'paused' WHERE id = '00000000-0000-0000-0000-0000000000a1';
SELECT expect('c01', false, 'org_not_live', 'pause: hidden');
SELECT expect('c06', false, 'org_not_live', 'pause: hidden (new)');
SELECT expect('c02', false, NULL, 'pause: admin-off untouched');
-- admin tries to switch one on while paused => held, not shown
UPDATE products SET is_active = true WHERE id = '00000000-0000-0000-0000-000000000c02';
SELECT expect('c02', false, 'org_not_live', 'admin switch-on while paused: held');
-- admin switches a held one off while paused => stays off after resume
UPDATE products SET is_active = false WHERE id = '00000000-0000-0000-0000-000000000c06';
SELECT expect('c06', false, NULL, 'admin switch-off while paused clears hold');

-- 7. Resume L
UPDATE partner_organizations SET lifecycle_state = 'live' WHERE id = '00000000-0000-0000-0000-0000000000a1';
SELECT expect('c01', true,  NULL, 'resume: back on');
SELECT expect('c02', true,  NULL, 'resume: admin switch-on made while paused applies');
SELECT expect('c06', false, NULL, 'resume: admin-off stays off');

-- 8. Owner of org L registered as a test account => everything off, reason excluded
INSERT INTO notification_test_actors VALUES ('00000000-0000-0000-0000-00000000aaa1');
SELECT expect('c01', false, 'excluded_account', 'test owner: hidden');
SELECT expect('c02', false, 'excluded_account', 'test owner: hidden 2');
INSERT INTO products (id, merchant_id, title, is_active) VALUES ('00000000-0000-0000-0000-000000000c08','00000000-0000-0000-0000-0000000000b1','L test new', true);
SELECT expect('c08', false, NULL, 'test owner: new product never on');
DELETE FROM notification_test_actors;
SELECT expect('c01', true, NULL, 'test owner removed: back');
SELECT expect('c08', true, NULL, 'test owner removed: waiting draft on');

-- 9. Owner-keyed merchant (no org) owned by a service account: admin can't show it
INSERT INTO service_bot_accounts VALUES ('00000000-0000-0000-0000-00000000bbb1');
INSERT INTO merchants (id, owner_user_id) VALUES ('00000000-0000-0000-0000-0000000000b4','00000000-0000-0000-0000-00000000bbb1');
INSERT INTO products (id, merchant_id, title, is_active) VALUES ('00000000-0000-0000-0000-000000000c09','00000000-0000-0000-0000-0000000000b4','bot', true);
SELECT expect('c09', false, NULL, 'service-account merchant product never on');

-- 10. Legacy owner-keyed merchant adopted into a live org (catalogue route) => on
INSERT INTO merchants (id, owner_user_id) VALUES ('00000000-0000-0000-0000-0000000000b5','00000000-0000-0000-0000-00000000aaa1');
INSERT INTO products (id, merchant_id, title, is_active) VALUES ('00000000-0000-0000-0000-000000000c10','00000000-0000-0000-0000-0000000000b5','legacy draft', false);
SELECT expect('c10', false, NULL, 'legacy owner merchant: untouched draft');
UPDATE merchants SET partner_organization_id = '00000000-0000-0000-0000-0000000000a1' WHERE id = '00000000-0000-0000-0000-0000000000b5';
SELECT expect('c10', true, NULL, 'adopted into live org: on');

-- 11. Network product admin toggles still work exactly as before
UPDATE products SET is_active = true WHERE id = '00000000-0000-0000-0000-000000000c05';
SELECT expect('c05', true, NULL, 'network admin switch-on');

-- 12. Suspend D => held, reason current
UPDATE partner_organizations SET lifecycle_state = 'suspended' WHERE id = '00000000-0000-0000-0000-0000000000a2';
SELECT expect('c03', false, 'org_not_live', 'suspend: hidden');

-- 12b. A product moved between merchants (no is_active in the decision)
INSERT INTO products (id, merchant_id, title, is_active) VALUES ('00000000-0000-0000-0000-000000000c11','00000000-0000-0000-0000-0000000000b2','D moving', false);
SELECT expect('c11', false, NULL, 'insert while suspended: waiting');
UPDATE products SET merchant_id = '00000000-0000-0000-0000-0000000000b1' WHERE id = '00000000-0000-0000-0000-000000000c11';
SELECT expect('c11', true, NULL, 'moved to a live org: on');
UPDATE products SET merchant_id = '00000000-0000-0000-0000-0000000000b2' WHERE id = '00000000-0000-0000-0000-000000000c11';
SELECT expect('c11', false, 'org_not_live', 'moved back to suspended org: held');

-- 14. First-time supplier: org registered (draft), then products added by hand
INSERT INTO partner_organizations (id, lifecycle_state, owner_user_id) VALUES ('00000000-0000-0000-0000-0000000000a3','draft','00000000-0000-0000-0000-00000000aaa3');
INSERT INTO merchants (id, owner_user_id) VALUES ('00000000-0000-0000-0000-0000000000b6','00000000-0000-0000-0000-00000000aaa3');
DO $$ BEGIN IF (SELECT partner_organization_id FROM merchants WHERE id='00000000-0000-0000-0000-0000000000b6') IS DISTINCT FROM '00000000-0000-0000-0000-0000000000a3' THEN RAISE EXCEPTION 'FAIL hand merchant not linked to its owner''s org'; END IF; RAISE NOTICE 'ok  hand merchant linked to owner''s single org'; END $$;
INSERT INTO products (id, merchant_id, title, is_active) VALUES ('00000000-0000-0000-0000-000000000c12','00000000-0000-0000-0000-0000000000b6','hand draft', false);
SELECT expect('c12', false, NULL, 'hand product waits');
UPDATE partner_organizations SET status = 'active' WHERE id = '00000000-0000-0000-0000-0000000000a3';
SELECT expect('c12', true, NULL, 'team Activate: hand product on Discover');

-- 15. Products added by hand BEFORE registering the org: adopted at registration
INSERT INTO merchants (id, owner_user_id) VALUES ('00000000-0000-0000-0000-0000000000b7','00000000-0000-0000-0000-00000000aaa4');
INSERT INTO products (id, merchant_id, title, is_active) VALUES ('00000000-0000-0000-0000-000000000c13','00000000-0000-0000-0000-0000000000b7','early draft', false);
INSERT INTO partner_organizations (id, lifecycle_state, owner_user_id) VALUES ('00000000-0000-0000-0000-0000000000a4','draft','00000000-0000-0000-0000-00000000aaa4');
DO $$ BEGIN IF (SELECT partner_organization_id FROM merchants WHERE id='00000000-0000-0000-0000-0000000000b7') IS DISTINCT FROM '00000000-0000-0000-0000-0000000000a4' THEN RAISE EXCEPTION 'FAIL earlier merchant not adopted at registration'; END IF; RAISE NOTICE 'ok  earlier hand merchant adopted when the org registers'; END $$;
UPDATE partner_organizations SET lifecycle_state = 'live' WHERE id = '00000000-0000-0000-0000-0000000000a4';
SELECT expect('c13', true, NULL, 'adopted merchant: on at go-live');

-- 16. Owner of two orgs: never guessed
INSERT INTO partner_organizations (lifecycle_state, owner_user_id) VALUES ('live','00000000-0000-0000-0000-00000000aaa5'), ('live','00000000-0000-0000-0000-00000000aaa5');
INSERT INTO merchants (id, owner_user_id) VALUES ('00000000-0000-0000-0000-0000000000b8','00000000-0000-0000-0000-00000000aaa5');
DO $$ BEGIN IF (SELECT partner_organization_id FROM merchants WHERE id='00000000-0000-0000-0000-0000000000b8') IS NOT NULL THEN RAISE EXCEPTION 'FAIL linked although owner has two orgs'; END IF; RAISE NOTICE 'ok  two orgs: not linked'; END $$;

-- 17. Org that already has a merchant: a second hand merchant is not linked
INSERT INTO merchants (id, owner_user_id) VALUES ('00000000-0000-0000-0000-0000000000b9','00000000-0000-0000-0000-00000000aaa3');
DO $$ BEGIN IF (SELECT partner_organization_id FROM merchants WHERE id='00000000-0000-0000-0000-0000000000b9') IS NOT NULL THEN RAISE EXCEPTION 'FAIL second merchant linked to the same org'; END IF; RAISE NOTICE 'ok  org already has a merchant: second not linked'; END $$;

-- 13. Migration is re-runnable
\i supabase/migrations/20261001120000_vtid_04769_supplier_go_live_lists_products.sql
SELECT expect('c03', false, 'org_not_live', 're-run: still held');
SELECT expect('c01', true, NULL, 're-run: still on');
SELECT 'ALL PASSED' AS result;
