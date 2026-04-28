-- Dance specialized market — Phase D1.3 (VTID-DANCE-D1)
-- Extend live_rooms (and meetups when present) with the columns the matcher
-- needs to federate dance intents over events. Idempotent.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='live_rooms') THEN
    EXECUTE $sql$
      ALTER TABLE public.live_rooms
        ADD COLUMN IF NOT EXISTS category text,
        ADD COLUMN IF NOT EXISTS price_cents int,
        ADD COLUMN IF NOT EXISTS currency text DEFAULT 'EUR',
        ADD COLUMN IF NOT EXISTS capacity int,
        ADD COLUMN IF NOT EXISTS location_label text,
        ADD COLUMN IF NOT EXISTS dance_payload jsonb DEFAULT '{}'::jsonb;
    $sql$;

    -- Comment for posterity.
    EXECUTE $sql$
      COMMENT ON COLUMN public.live_rooms.category IS
        'Optional taxonomy label for matcher federation (e.g. dance.learning.salsa, dance.class_paid). Matches intent_categories.category_key when set.';
    $sql$;
    EXECUTE $sql$
      COMMENT ON COLUMN public.live_rooms.price_cents IS
        'NULL or 0 = free event; >0 = paid (Pro/Biz tier required to set per business model). Currency in adjacent column.';
    $sql$;

    -- Index for matcher federation (only when category is set).
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS live_rooms_category_starts_idx
        ON public.live_rooms (category, starts_at DESC)
        WHERE category IS NOT NULL;
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='meetups') THEN
    EXECUTE $sql$
      ALTER TABLE public.meetups
        ADD COLUMN IF NOT EXISTS category text,
        ADD COLUMN IF NOT EXISTS price_cents int,
        ADD COLUMN IF NOT EXISTS currency text DEFAULT 'EUR',
        ADD COLUMN IF NOT EXISTS dance_payload jsonb DEFAULT '{}'::jsonb;
    $sql$;
  END IF;
END $$;
