-- VTID-03894 — multi-vertical supplier self-service.
--
-- WHY THIS EXISTS
--
-- `products` (VTID-02000) gives every vertical-specific attribute its own typed
-- column, and every one of them is supplement-shaped: health_goals,
-- dietary_tags, ingredients_primary, contains_allergens,
-- contraindicated_with_conditions/medications, form (capsule|tablet|powder…).
--
-- Vitanaland is now onboarding wine growers, textile mills, gym-equipment
-- makers and diagnostics labs. Under the existing shape, "support wine" means a
-- migration adding vintage/region/grape/abv, "support clothing" means another
-- adding sizes/materials, and a self-service onboarding UI can never add a
-- category on its own. CLAUDE.md §13c asks for the opposite: prefer choices a
-- future onboarding UI could drive over ones only an engineer with a migration
-- could drive.
--
-- So: ONE jsonb column for vertical attributes, plus DATA that describes which
-- attributes each vertical has. Adding "cosmetics" then becomes an INSERT.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It does not touch the existing health columns. They are load-bearing —
-- `user_limitations` hard-filters on contains_allergens and
-- contraindicated_with_*, and Discover reads health_goals/dietary_tags. Moving
-- them into jsonb would break a safety filter to win tidiness. New verticals
-- use `attributes`; supplements keep their indexed columns.

BEGIN;

-- ===========================================================================
-- 1. Vertical attributes on products
-- ===========================================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.products.attributes IS
  'VTID-03894: vertical-specific attributes, keyed by catalog_vertical_fields.field_key '
  '(e.g. {"vintage":2019,"grape":"Nebbiolo"}). Health/supplement attributes stay in '
  'their own indexed columns — user_limitations filters on those.';

-- Containment index: "wine from 2019", "shirts in linen" are @> lookups.
CREATE INDEX IF NOT EXISTS idx_products_attributes
  ON public.products USING GIN (attributes jsonb_path_ops);

-- ===========================================================================
-- 2. Verticals
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.catalog_verticals (
  key           TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,48}$'),
  display_label TEXT NOT NULL,
  description   TEXT,
  icon          TEXT,                       -- lucide-react icon name, resolved client-side
  -- Supplements/diagnostics carry regulated claims; the portal shows extra
  -- compliance copy for these and review is never skipped.
  is_regulated  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INT NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.catalog_verticals IS
  'VTID-03894: supplier-facing verticals. Rows, not an enum, so the onboarding UI '
  'can gain a category without a migration.';

-- ===========================================================================
-- 3. Field definitions per vertical
--
-- One row = one question a supplier is asked about a product in that vertical.
-- This single table drives BOTH the product form and the generated spreadsheet
-- template, so the two can never disagree about what a wine needs.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.catalog_vertical_fields (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical_key  TEXT NOT NULL REFERENCES public.catalog_verticals(key) ON DELETE CASCADE,
  field_key     TEXT NOT NULL CHECK (field_key ~ '^[a-z][a-z0-9_]{1,48}$'),
  display_label TEXT NOT NULL,
  help_text     TEXT,
  data_type     TEXT NOT NULL
    CHECK (data_type IN ('text','number','integer','boolean','date','enum','multi_enum','url')),
  -- For enum/multi_enum: which catalog_vocabulary.vocabulary holds the options.
  -- Reuses the existing allowed-values table rather than inventing a second one.
  vocabulary    TEXT,
  unit          TEXT,                       -- 'cm', 'kg', '% ABV' — display only
  -- NOT a publish gate. A listing is publishable on the universal core alone;
  -- these drive the "listing strength" nudge instead. A supplier who cannot
  -- answer a question must still be able to list.
  is_prominent  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INT NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vertical_key, field_key),
  -- An enum field without a vocabulary has no options to offer; catching it
  -- here beats rendering an empty dropdown to a supplier.
  CONSTRAINT catalog_vertical_fields_enum_needs_vocabulary
    CHECK (data_type NOT IN ('enum','multi_enum') OR vocabulary IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_catalog_vertical_fields_lookup
  ON public.catalog_vertical_fields (vertical_key, sort_order)
  WHERE is_active = TRUE;

-- ===========================================================================
-- 4. Widen catalog_vocabulary
--
-- Its CHECK hardcoded the six health vocabularies, so a wine grape list or a
-- garment-size list could not be stored in the table that exists precisely to
-- store allowed values. Replaced with a shape constraint; catalog_vertical_fields
-- references vocabularies by name.
-- ===========================================================================

ALTER TABLE public.catalog_vocabulary
  DROP CONSTRAINT IF EXISTS catalog_vocabulary_vocabulary_check;

ALTER TABLE public.catalog_vocabulary
  ADD CONSTRAINT catalog_vocabulary_vocabulary_check
  CHECK (vocabulary ~ '^[a-z][a-z0-9_]{1,48}$');

-- ===========================================================================
-- 5. Merchant ownership
--
-- `merchants` is shaped by ingestion source and has no owner, so a
-- self-registered supplier has nowhere to live. `partner_tenant` (VTID-03553)
-- already carries owner_user_id for the connection/onboarding world. Link them
-- rather than inventing a third supplier concept.
-- ===========================================================================

ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS owner_user_id UUID,
  ADD COLUMN IF NOT EXISTS partner_tenant_id UUID,
  ADD COLUMN IF NOT EXISTS vertical_key TEXT REFERENCES public.catalog_verticals(key),
  -- Self-registered suppliers start unreviewed. Nothing they upload reaches
  -- Discover until this says so — the platform-owner decision recorded for
  -- VTID-03894 was open signup WITH review before going live.
  ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (onboarding_status IN ('draft','in_review','approved','rejected','suspended'));

CREATE INDEX IF NOT EXISTS idx_merchants_owner
  ON public.merchants (owner_user_id)
  WHERE owner_user_id IS NOT NULL;

COMMENT ON COLUMN public.merchants.onboarding_status IS
  'VTID-03894: gates a self-registered supplier''s catalogue. Only ''approved'' is '
  'eligible to surface in Discover.';

COMMIT;
