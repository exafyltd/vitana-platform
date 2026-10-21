-- VTID-04783 — Commerce products land in the matching Discover category.
--
-- Until now Discover's categories lived in four hardcoded copies in the
-- frontend (supplements / skincare / health-tests), and a supplier product
-- stored its vertical key (`beauty_care`, `diagnostics`, ...) as
-- products.category — so only supplements ever matched, and no supplier
-- product had a subcategory, which Discover's sections drop.
--
-- Categories become data (owner direction 2026-10-01: "there will be even
-- more categories by time"): adding one is a row here plus its label in the
-- frontend i18n catalogue — no code change. Labels are i18n KEYS, never text
-- (backend-supplied UI text ships as keys).
--
--   discover_categories     key, label_key, icon, sort_order, is_active
--   discover_subcategories  (category_key, key), label_key, sort_order, is_active
--   catalog_verticals.discover_category   which Discover category a supplier
--                                         vertical lands in (NULL = none yet)
--
-- A products trigger maps every SUPPLIER product (merchant linked to a
-- partner organization or owned by a user — the same definition as the
-- VTID-04769 go-live gate) onto its Discover category, whatever path wrote
-- it (product form, API, CSV import), and keeps a subcategory only when it is
-- one of that category's known keys. Network products are never touched.
-- The gateway gains GET /discover/categories and the subcategory field in the
-- same PR.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.discover_categories (
  key         TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9-]{1,48}$'),
  label_key   TEXT NOT NULL,
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.discover_subcategories (
  category_key TEXT NOT NULL REFERENCES public.discover_categories(key) ON UPDATE CASCADE,
  key          TEXT NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{1,48}$'),
  label_key    TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 100,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (category_key, key)
);

COMMENT ON TABLE public.discover_categories IS
  'VTID-04783: Discover product categories as data. label_key is a frontend i18n key. A category shows in Discover once it has live products.';
COMMENT ON TABLE public.discover_subcategories IS
  'VTID-04783: subcategories per Discover category; products.subcategory must be one of these keys to be grouped.';

-- Public catalogue metadata: anyone may read, only the service role writes.
ALTER TABLE public.discover_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discover_subcategories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS discover_categories_read ON public.discover_categories;
CREATE POLICY discover_categories_read ON public.discover_categories FOR SELECT USING (true);
DROP POLICY IF EXISTS discover_subcategories_read ON public.discover_subcategories;
CREATE POLICY discover_subcategories_read ON public.discover_subcategories FOR SELECT USING (true);
GRANT SELECT ON public.discover_categories, public.discover_subcategories TO anon, authenticated;
GRANT ALL ON public.discover_categories, public.discover_subcategories TO service_role;

-- ---------------------------------------------------------------------------
-- Seed: the three categories Discover already shows (their existing subcategory
-- keys and i18n keys, unchanged), lifestyle (already used by live products),
-- and the new homes for supplier verticals that had none.
-- ---------------------------------------------------------------------------
INSERT INTO public.discover_categories (key, label_key, icon, sort_order) VALUES
  ('supplements',  'discover.categoryNames.supplements', 'pill',      10),
  ('skincare',     'discover.categoryNames.skincare',    'sparkles',  20),
  ('health-tests', 'discover.categoryNames.healthTests', 'test-tube', 30),
  ('fitness',      'discover.categoryNames.fitness',     'dumbbell',  40),
  ('apparel',      'discover.categoryNames.apparel',     'shirt',     50),
  ('devices',      'discover.categoryNames.devices',     'watch',     60),
  ('home',         'discover.categoryNames.home',        'home',      70),
  ('drinks',       'discover.categoryNames.drinks',      'wine',      80),
  ('lifestyle',    'discover.categoryNames.lifestyle',   'leaf',      90)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.discover_subcategories (category_key, key, label_key, sort_order) VALUES
  ('supplements', 'longevity',             'discover.subcategories.longevity',            10),
  ('supplements', 'adaptogens',            'discover.subcategories.adaptogens',           20),
  ('supplements', 'vitamins',              'discover.subcategories.vitamins',             30),
  ('supplements', 'essential-fatty-acids', 'discover.subcategories.essentialFattyAcids',  40),
  ('supplements', 'minerals',              'discover.subcategories.minerals',             50),
  ('supplements', 'immunity',              'discover.subcategories.immunity',             60),
  ('supplements', 'beauty',                'discover.subcategories.beauty',               70),
  ('supplements', 'nootropics',            'discover.subcategories.nootropics',           80),
  ('supplements', 'performance',           'discover.subcategories.performance',          90),
  ('supplements', 'antioxidants',          'discover.subcategories.antioxidants',        100),
  ('skincare',    'face-care',             'discover.subcategories.faceCare',             10),
  ('skincare',    'makeup',                'discover.subcategories.makeup',               20),
  ('skincare',    'hair-care',             'discover.subcategories.hairCare',             30),
  ('skincare',    'body-care',             'discover.subcategories.bodyCare',             40),
  ('skincare',    'fragrance',             'discover.subcategories.fragrance',            50),
  ('skincare',    'sun-care',              'discover.subcategories.sunCare',              60),
  ('health-tests','nutrients-vitamins',    'discover.subcategories.nutrientsVitamins',    10),
  ('health-tests','hormones',              'discover.subcategories.hormones',             20),
  ('health-tests','cardio',                'discover.subcategories.cardio',               30),
  ('health-tests','longevity-fitness',     'discover.subcategories.longevityFitness',     40),
  ('health-tests','womens-health',         'discover.subcategories.womensHealth',         50),
  ('health-tests','sexual-health',         'discover.subcategories.sexualHealth',         60),
  ('health-tests','prevention',            'discover.subcategories.prevention',           70),
  ('health-tests','general-health',        'discover.subcategories.generalHealth',        80),
  ('health-tests','dna-analysis',          'discover.subcategories.dnaAnalysis',          90),
  ('lifestyle',   'safety',                'discover.subcategories.safety',               10)
ON CONFLICT (category_key, key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Supplier vertical -> Discover category (owner-approved mapping, 2026-10-01).
-- services: none yet — practitioners and services get their own Discover
-- surface in step C.
-- ---------------------------------------------------------------------------
ALTER TABLE public.catalog_verticals
  ADD COLUMN IF NOT EXISTS discover_category TEXT REFERENCES public.discover_categories(key) ON UPDATE CASCADE;

COMMENT ON COLUMN public.catalog_verticals.discover_category IS
  'VTID-04783: the Discover category a supplier product of this vertical lands in. NULL = no Discover category yet (search only).';

UPDATE public.catalog_verticals v SET discover_category = m.cat
  FROM (VALUES
    ('supplements',       'supplements'),
    ('diagnostics',       'health-tests'),
    ('beauty_care',       'skincare'),
    ('fitness_equipment', 'fitness'),
    ('apparel',           'apparel'),
    ('devices_wearables', 'devices'),
    ('home_living',       'home'),
    ('wine_spirits',      'drinks'),
    ('other',             'lifestyle')
  ) AS m(vertical, cat)
 WHERE v.key = m.vertical
   AND v.discover_category IS NULL;

-- ---------------------------------------------------------------------------
-- products: supplier products land in their Discover category.
-- The vertical comes from the merchant (authoritative) or, failing that, from
-- a vertical key written into products.category (the product form and the
-- CSV template both do that). A value that is already a Discover category is
-- kept. A subcategory survives only if it belongs to the resulting category.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_products_discover_category()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier BOOLEAN;
  v_vertical TEXT;
  v_cat      TEXT;
BEGIN
  SELECT (m.partner_organization_id IS NOT NULL OR m.owner_user_id IS NOT NULL), m.vertical_key
    INTO v_supplier, v_vertical
    FROM merchants m WHERE m.id = NEW.merchant_id;
  IF NOT COALESCE(v_supplier, FALSE) THEN
    RETURN NEW;                       -- network product: untouched
  END IF;

  IF NEW.category IS NOT NULL
     AND EXISTS (SELECT 1 FROM discover_categories WHERE key = NEW.category) THEN
    v_cat := NEW.category;            -- already a Discover category
  ELSE
    SELECT discover_category INTO v_cat FROM catalog_verticals
     WHERE key = COALESCE(
       CASE WHEN EXISTS (SELECT 1 FROM catalog_verticals WHERE key = NEW.category) THEN NEW.category END,
       v_vertical);
  END IF;

  IF v_cat IS NOT NULL THEN
    NEW.category := v_cat;
  END IF;

  IF NEW.subcategory IS NOT NULL THEN
    NEW.subcategory := lower(btrim(NEW.subcategory));
    IF NOT EXISTS (SELECT 1 FROM discover_subcategories
                    WHERE category_key = NEW.category AND key = NEW.subcategory AND is_active) THEN
      NEW.subcategory := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_discover_category ON public.products;
CREATE TRIGGER trg_products_discover_category
  BEFORE INSERT OR UPDATE OF category, subcategory, merchant_id ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.trg_products_discover_category();

-- ---------------------------------------------------------------------------
-- Live counts for Discover's category list (active products only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.discover_category_counts()
RETURNS TABLE (category TEXT, subcategory TEXT, product_count BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.category, p.subcategory, count(*)
    FROM products p
    JOIN discover_categories c ON c.key = p.category AND c.is_active
   WHERE p.is_active
   GROUP BY p.category, p.subcategory;
$$;

REVOKE ALL ON FUNCTION public.discover_category_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.discover_category_counts() TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.trg_products_discover_category() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Backfill existing supplier products (touches category/subcategory only;
-- the VTID-04769 go-live gate reacts to is_active/merchant_id, not these).
-- ---------------------------------------------------------------------------
UPDATE public.products p
   SET category = p.category
  FROM public.merchants m
 WHERE p.merchant_id = m.id
   AND (m.partner_organization_id IS NOT NULL OR m.owner_user_id IS NOT NULL);
