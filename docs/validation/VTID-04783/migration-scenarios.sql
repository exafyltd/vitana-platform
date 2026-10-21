-- VTID-04783 migration scenarios. Run from the repo root against a THROWAWAY
-- local Postgres (never a shared database):
--   createdb t && psql -v ON_ERROR_STOP=1 -d t -f docs/validation/VTID-04783/migration-scenarios.sql
\set ON_ERROR_STOP on
DO $$ BEGIN CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Stub schema: only the columns the migration reads/writes.
CREATE TABLE catalog_verticals (key text PRIMARY KEY);
INSERT INTO catalog_verticals VALUES ('supplements'),('diagnostics'),('fitness_equipment'),('apparel'),('wine_spirits'),
  ('beauty_care'),('devices_wearables'),('home_living'),('services'),('other');
CREATE TABLE merchants (id uuid PRIMARY KEY, partner_organization_id uuid, owner_user_id uuid, vertical_key text);
CREATE TABLE products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid, title text,
  category text, subcategory text, is_active boolean NOT NULL DEFAULT true);

-- network merchant (no org, no owner) and an existing supplier product
INSERT INTO merchants VALUES
  ('00000000-0000-0000-0000-0000000000b1', NULL, NULL, NULL),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', NULL, 'beauty_care'),
  ('00000000-0000-0000-0000-0000000000b3', NULL, '00000000-0000-0000-0000-00000000aaa1', 'fitness_equipment'),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000a2', NULL, 'services');
INSERT INTO products (id, merchant_id, title, category, subcategory) VALUES
  ('00000000-0000-0000-0000-000000000c01','00000000-0000-0000-0000-0000000000b1','network skincare','skincare','makeup'),
  ('00000000-0000-0000-0000-000000000c02','00000000-0000-0000-0000-0000000000b1','network odd','Kitchen,Dining & Bar', 'whatever'),
  ('00000000-0000-0000-0000-000000000c03','00000000-0000-0000-0000-0000000000b2','existing supplier beauty','beauty_care', NULL);

\i supabase/migrations/20261001140000_vtid_04783_discover_categories.sql

CREATE FUNCTION expect(p_id text, p_cat text, p_sub text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r products%ROWTYPE; BEGIN
  SELECT * INTO r FROM products WHERE id = ('00000000-0000-0000-0000-000000000' || p_id)::uuid;
  IF r.category IS DISTINCT FROM p_cat OR r.subcategory IS DISTINCT FROM p_sub THEN
    RAISE EXCEPTION 'FAIL %: % category=% subcategory=% (want % %)', p_label, r.title, r.category, r.subcategory, p_cat, p_sub;
  END IF;
  RAISE NOTICE 'ok  %', p_label;
END $$;

-- 1. Backfill
SELECT expect('c01', 'skincare', 'makeup', 'network product untouched');
SELECT expect('c02', 'Kitchen,Dining & Bar', 'whatever', 'network product with odd category untouched');
SELECT expect('c03', 'skincare', NULL, 'existing supplier beauty product moved to skincare');

-- 2. Mapping (vertical key written as category, as the product form does)
INSERT INTO products (id, merchant_id, title, category, subcategory) VALUES
  ('00000000-0000-0000-0000-000000000c04','00000000-0000-0000-0000-0000000000b2','form beauty','beauty_care','face-care');
SELECT expect('c04', 'skincare', 'face-care', 'beauty_care -> skincare, known subcategory kept');

-- 3. Unknown subcategory dropped, product still lands
INSERT INTO products (id, merchant_id, title, category, subcategory) VALUES
  ('00000000-0000-0000-0000-000000000c05','00000000-0000-0000-0000-0000000000b2','bad sub','beauty_care','vitamins');
SELECT expect('c05', 'skincare', NULL, 'subcategory of another category dropped');

-- 4. Category empty (CSV without category): merchant vertical decides
INSERT INTO products (id, merchant_id, title, category) VALUES
  ('00000000-0000-0000-0000-000000000c06','00000000-0000-0000-0000-0000000000b3','csv no category', NULL);
SELECT expect('c06', 'fitness', NULL, 'owner-keyed fitness merchant -> fitness');

-- 5. A Discover category written directly is kept; subcategory normalised
INSERT INTO products (id, merchant_id, title, category, subcategory) VALUES
  ('00000000-0000-0000-0000-000000000c07','00000000-0000-0000-0000-0000000000b2','direct','supplements','  Vitamins ');
SELECT expect('c07', 'supplements', 'vitamins', 'Discover category kept, subcategory trimmed and lower-cased');

-- 6. A vertical key written as category wins over the merchant's vertical
INSERT INTO products (id, merchant_id, title, category) VALUES
  ('00000000-0000-0000-0000-000000000c08','00000000-0000-0000-0000-0000000000b3','csv diagnostics row','diagnostics');
SELECT expect('c08', 'health-tests', NULL, 'diagnostics -> health-tests');

-- 7. services has no Discover category yet: left as is (search only)
INSERT INTO products (id, merchant_id, title, category) VALUES
  ('00000000-0000-0000-0000-000000000c09','00000000-0000-0000-0000-0000000000b4','a programme', NULL);
SELECT expect('c09', NULL, NULL, 'services vertical: no Discover category');

-- 8. Free-text category (old CSV sample "fitness"... is a Discover key now) and nonsense
INSERT INTO products (id, merchant_id, title, category) VALUES
  ('00000000-0000-0000-0000-000000000c10','00000000-0000-0000-0000-0000000000b3','free text','gym stuff');
SELECT expect('c10', 'fitness', NULL, 'unknown free text falls back to the merchant vertical');

-- 9. Editing the subcategory later
UPDATE products SET subcategory = 'makeup' WHERE id = '00000000-0000-0000-0000-000000000c03';
SELECT expect('c03', 'skincare', 'makeup', 'subcategory edit kept');

-- 10. New category added as data only, mapped from a vertical
INSERT INTO discover_categories (key, label_key, sort_order) VALUES ('sleep', 'discover.categoryNames.sleep', 95);
INSERT INTO discover_subcategories (category_key, key, label_key) VALUES ('sleep', 'mattresses', 'discover.subcategories.mattresses');
INSERT INTO catalog_verticals VALUES ('sleep_gear');
UPDATE catalog_verticals SET discover_category = 'sleep' WHERE key = 'sleep_gear';
INSERT INTO products (id, merchant_id, title, category, subcategory) VALUES
  ('00000000-0000-0000-0000-000000000c11','00000000-0000-0000-0000-0000000000b3','new vertical','sleep_gear','mattresses');
SELECT expect('c11', 'sleep', 'mattresses', 'a category added as data works with no code change');

-- 11. Counts: active products only, only known categories
UPDATE products SET is_active = false WHERE id = '00000000-0000-0000-0000-000000000c05';
DO $$ DECLARE n bigint; BEGIN
  SELECT sum(product_count) INTO n FROM discover_category_counts() WHERE category = 'skincare';
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL counts: skincare % (want 3)', n; END IF;
  IF EXISTS (SELECT 1 FROM discover_category_counts() WHERE category = 'Kitchen,Dining & Bar') THEN
    RAISE EXCEPTION 'FAIL counts include an unknown category'; END IF;
  RAISE NOTICE 'ok  counts: active products in known categories only';
END $$;

-- 12. Re-runnable
\i supabase/migrations/20261001140000_vtid_04783_discover_categories.sql
SELECT expect('c04', 'skincare', 'face-care', 're-run: unchanged');
SELECT expect('c01', 'skincare', 'makeup', 're-run: network untouched');
SELECT 'ALL PASSED' AS result;
