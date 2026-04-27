-- Vitana ID v2 — chronological sequence suffix (VTID-01987)
-- Replaces the random 4-digit suffix with a global registration sequence so
-- user #N has a vitana_id ending in N. Easier to dictate by voice, easier to
-- quote in support tickets, registration order discoverable from the ID alone.
--
-- This migration only adds the schema primitives. The generator swap, the
-- re-mint backfill of existing users, and the denormalized snapshot
-- re-backfill all land in subsequent migrations.

-- 1. Global registration sequence. New signups call nextval() exactly once
--    inside handle_new_user; the value becomes the ID suffix and is also
--    written to profiles.registration_seq for direct queryability.
CREATE SEQUENCE IF NOT EXISTS public.vitana_id_seq
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  CACHE 1;

-- 2. Direct numeric handle on profiles. Avoids parsing the suffix from
--    vitana_id every time we need "what is user N?"
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS registration_seq bigint UNIQUE;

CREATE INDEX IF NOT EXISTS profiles_registration_seq_idx
  ON public.profiles(registration_seq);

-- 3. Relax the format check. Old: 4-12 chars (random suffix was always 4-5
--    digits). New: 4-16 chars to comfortably hold a 5-base + 6-digit suffix
--    well past 9,999 users, with headroom for chosen-base overrides up to 8
--    chars + 5-digit suffix.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_vitana_id_format_chk;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_vitana_id_format_chk
  CHECK (vitana_id ~ '^[a-z][a-z0-9]{3,15}$');
