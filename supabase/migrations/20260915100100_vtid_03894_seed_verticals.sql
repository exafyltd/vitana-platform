-- VTID-03894 — the starting vertical set and the questions each one asks.
--
-- This is DATA, deliberately. Adding "cosmetics" or a new question later is an
-- INSERT a back-office screen can make, not a migration. Everything here is
-- idempotent so re-running is safe.
--
-- FIELD SELECTION RULE: only attributes a BUYER filters or decides on. A
-- supplier's patience is the scarce resource — every question has to earn its
-- place by changing whether someone buys. Internal data (warehouse codes, cost
-- price) is deliberately absent.
--
-- NOTHING HERE IS REQUIRED TO PUBLISH. The universal core (title, price,
-- currency, image, origin country) is the only gate; these drive the listing-
-- strength nudge. A grower who does not know their ABV must still be able to
-- list their wine.

BEGIN;

INSERT INTO public.catalog_verticals (key, display_label, description, icon, is_regulated, sort_order) VALUES
  ('supplements',       'Supplements & nutrition',    'Vitamins, minerals, protein, functional foods.',        'Pill',        TRUE,  10),
  ('diagnostics',       'Lab & blood tests',          'At-home kits, lab panels, screening services.',         'TestTube',    TRUE,  20),
  ('fitness_equipment', 'Fitness & training gear',    'Weights, machines, mats, recovery tools.',              'Dumbbell',    FALSE, 30),
  ('apparel',           'Clothing & textiles',        'Activewear, everyday clothing, fabrics, bedding.',      'Shirt',       FALSE, 40),
  ('wine_spirits',      'Wine & fine drinks',         'Wine, spirits, low- and no-alcohol drinks.',            'Wine',        TRUE,  50),
  ('beauty_care',       'Beauty & personal care',     'Skincare, haircare, topical wellbeing products.',       'Sparkles',    TRUE,  60),
  ('devices_wearables', 'Devices & wearables',        'Trackers, scales, monitors, recovery devices.',         'Watch',       FALSE, 70),
  ('home_living',       'Home & living',              'Sleep, air, light, kitchen and home wellbeing.',        'House',       FALSE, 80),
  ('services',          'Services & programmes',      'Coaching, consultations, retreats, memberships.',       'CalendarHeart', FALSE, 90),
  ('other',             'Something else',             'Anything that does not fit the categories above.',      'Package',     FALSE, 999)
ON CONFLICT (key) DO UPDATE SET
  display_label = EXCLUDED.display_label,
  description   = EXCLUDED.description,
  icon          = EXCLUDED.icon,
  is_regulated  = EXCLUDED.is_regulated,
  sort_order    = EXCLUDED.sort_order;

-- ---------------------------------------------------------------------------
-- Option lists for the enum fields below. catalog_vocabulary already exists for
-- exactly this; migration 20260915100000 widened it to accept non-health names.
-- ---------------------------------------------------------------------------

INSERT INTO public.catalog_vocabulary (vocabulary, value, display_label, sort_order) VALUES
  ('wine_style','red','Red',10),
  ('wine_style','white','White',20),
  ('wine_style','rose','Rosé',30),
  ('wine_style','sparkling','Sparkling',40),
  ('wine_style','dessert','Dessert',50),
  ('wine_style','no_low_alcohol','No / low alcohol',60),

  ('size_system','eu','EU',10),
  ('size_system','uk','UK',20),
  ('size_system','us','US',30),
  ('size_system','alpha','S / M / L',40),
  ('size_system','one_size','One size',50),

  ('sample_type','blood_venous','Blood — venous draw',10),
  ('sample_type','blood_finger','Blood — finger prick',20),
  ('sample_type','saliva','Saliva',30),
  ('sample_type','urine','Urine',40),
  ('sample_type','stool','Stool',50),
  ('sample_type','swab','Swab',60),

  ('service_format','in_person','In person',10),
  ('service_format','online','Online',20),
  ('service_format','hybrid','Hybrid',30)
ON CONFLICT (vocabulary, value) DO UPDATE SET
  display_label = EXCLUDED.display_label,
  sort_order    = EXCLUDED.sort_order;

-- ---------------------------------------------------------------------------
-- The questions themselves.
-- ---------------------------------------------------------------------------

INSERT INTO public.catalog_vertical_fields
  (vertical_key, field_key, display_label, help_text, data_type, vocabulary, unit, is_prominent, sort_order) VALUES

  -- Supplements — the health columns on `products` already cover ingredients,
  -- allergens and dietary tags, so these are only what those do not capture.
  ('supplements','servings_per_pack','Servings per pack',NULL,'integer',NULL,NULL,TRUE,10),
  ('supplements','serving_size','Serving size','e.g. "2 capsules"','text',NULL,NULL,TRUE,20),
  ('supplements','dosage_strength','Strength per serving','e.g. "1000 mg"','text',NULL,NULL,FALSE,30),

  -- Diagnostics
  ('diagnostics','sample_type','Sample type',NULL,'enum','sample_type',NULL,TRUE,10),
  ('diagnostics','biomarkers_count','Number of biomarkers',NULL,'integer',NULL,NULL,TRUE,20),
  ('diagnostics','turnaround_days','Results turnaround','Working days from lab receipt.','integer',NULL,'days',TRUE,30),
  ('diagnostics','requires_clinic_visit','Needs a clinic visit',NULL,'boolean',NULL,NULL,FALSE,40),
  ('diagnostics','accredited_lab','Accrediting body','e.g. "UKAS", "CAP", "DAkkS"','text',NULL,NULL,FALSE,50),

  -- Fitness equipment
  ('fitness_equipment','weight_kg','Weight',NULL,'number',NULL,'kg',TRUE,10),
  ('fitness_equipment','dimensions','Dimensions (L×W×H)','e.g. "180 × 60 × 20 cm"','text',NULL,NULL,TRUE,20),
  ('fitness_equipment','max_user_weight_kg','Maximum user weight',NULL,'number',NULL,'kg',FALSE,30),
  ('fitness_equipment','assembly_required','Assembly required',NULL,'boolean',NULL,NULL,FALSE,40),

  -- Apparel & textiles
  ('apparel','size_system','Size system',NULL,'enum','size_system',NULL,TRUE,10),
  ('apparel','sizes_available','Sizes available','Comma-separated, e.g. "S, M, L, XL"','text',NULL,NULL,TRUE,20),
  ('apparel','material','Material','e.g. "80% merino, 20% nylon"','text',NULL,NULL,TRUE,30),
  ('apparel','colours','Colours available','Comma-separated.','text',NULL,NULL,FALSE,40),
  ('apparel','care_instructions','Care instructions',NULL,'text',NULL,NULL,FALSE,50),

  -- Wine & fine drinks
  ('wine_spirits','wine_style','Style',NULL,'enum','wine_style',NULL,TRUE,10),
  ('wine_spirits','vintage','Vintage','Leave empty for non-vintage.','integer',NULL,NULL,TRUE,20),
  ('wine_spirits','region','Region','e.g. "Barolo DOCG, Piedmont"','text',NULL,NULL,TRUE,30),
  ('wine_spirits','grape_variety','Grape / botanicals',NULL,'text',NULL,NULL,TRUE,40),
  ('wine_spirits','abv_percent','Alcohol by volume',NULL,'number',NULL,'% ABV',TRUE,50),
  ('wine_spirits','bottle_size_ml','Bottle size',NULL,'integer',NULL,'ml',FALSE,60),

  -- Beauty & personal care
  ('beauty_care','volume_ml','Volume',NULL,'number',NULL,'ml',TRUE,10),
  ('beauty_care','skin_type','Suited to','e.g. "dry, sensitive"','text',NULL,NULL,TRUE,20),
  ('beauty_care','key_actives','Key active ingredients',NULL,'text',NULL,NULL,FALSE,30),

  -- Devices & wearables
  ('devices_wearables','battery_life_hours','Battery life',NULL,'number',NULL,'hours',TRUE,10),
  ('devices_wearables','measures','What it measures','e.g. "heart rate, HRV, sleep stages"','text',NULL,NULL,TRUE,20),
  ('devices_wearables','app_required','Companion app required',NULL,'boolean',NULL,NULL,FALSE,30),
  ('devices_wearables','warranty_months','Warranty',NULL,'integer',NULL,'months',FALSE,40),

  -- Home & living
  ('home_living','dimensions','Dimensions (L×W×H)',NULL,'text',NULL,NULL,TRUE,10),
  ('home_living','material','Material',NULL,'text',NULL,NULL,TRUE,20),
  ('home_living','power_source','Power source','e.g. "mains", "battery", "none"','text',NULL,NULL,FALSE,30),

  -- Services & programmes. Not a physical product: no shipping, so duration
  -- and format are what a buyer actually decides on.
  ('services','service_format','Format',NULL,'enum','service_format',NULL,TRUE,10),
  ('services','duration_minutes','Session length',NULL,'integer',NULL,'minutes',TRUE,20),
  ('services','sessions_included','Sessions included',NULL,'integer',NULL,NULL,TRUE,30),
  ('services','languages','Languages offered','Comma-separated.','text',NULL,NULL,FALSE,40)

ON CONFLICT (vertical_key, field_key) DO UPDATE SET
  display_label = EXCLUDED.display_label,
  help_text     = EXCLUDED.help_text,
  data_type     = EXCLUDED.data_type,
  vocabulary    = EXCLUDED.vocabulary,
  unit          = EXCLUDED.unit,
  is_prominent  = EXCLUDED.is_prominent,
  sort_order    = EXCLUDED.sort_order;

-- 'other' deliberately has no fields: someone who does not fit a category
-- should meet the universal core and nothing more, not a wall of irrelevant
-- questions.

COMMIT;
