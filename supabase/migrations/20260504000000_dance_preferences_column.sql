-- Dance specialized market — Phase D1.1 (VTID-DANCE-D1)
-- Add a stable dance-preferences JSONB to profiles. The intent matcher
-- reads this as a +bias when an intent has a dance facet, and the future
-- DancePreferencesDrawer.tsx writes it. Visibility is governed by the
-- existing account_visibility map.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS dance_preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.profiles.dance_preferences IS
  'Stable dance preferences: { varieties[], levels{variety:level}, roles[], looking_for[], radius_km, venue_prefs[], availability_windows[] }. Read by the intent matcher as a +bias when an intent has a dance facet. Visibility governed by account_visibility.';

CREATE INDEX IF NOT EXISTS profiles_dance_prefs_gin
  ON public.profiles USING gin (dance_preferences);
