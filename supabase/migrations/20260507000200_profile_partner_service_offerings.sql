-- E2 — profiles.{partner_preferences, service_offerings} jsonb columns.
--
-- Adds the two structured profile sections that PART 5 needs:
--
-- partner_preferences: stable preferences the matchmaker reads as a +bias
-- when an intent has counterparty_filter overrides. Visibility gated by the
-- E5 account_visibility 'partnerPreferences' key (private by default —
-- private-first for women's protection per the user's 2026-04-29 ask).
-- Schema:
--   {
--     gender_pref: 'female' | 'male' | 'any',
--     age_range: [min, max],
--     max_radius_km: number,
--     location_label: string,
--     relationship_intent: 'dating' | 'life_partner' | 'companionship' | 'open',
--     must_haves: string[],
--     deal_breakers: string[]
--   }
--
-- service_offerings: services this user offers. Used by Find a Partner +
-- discover/marketplace. Visibility gated by E5 'serviceOfferings' key
-- (public by default — hiding defeats the purpose).
-- Schema:
--   {
--     offers: [{
--       category: string,           -- e.g. 'dance.teaching.salsa'
--       title: string,
--       short_description: string,
--       price_min_cents: number,
--       price_max_cents: number,
--       currency: string,
--       contact_via: 'message' | 'profile'
--     }]
--   }
--
-- Both default to '{}' so the column merges cleanly with existing rows.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS partner_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS service_offerings   jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS profiles_partner_prefs_gin
  ON public.profiles USING gin (partner_preferences);

CREATE INDEX IF NOT EXISTS profiles_service_offerings_gin
  ON public.profiles USING gin (service_offerings);

COMMENT ON COLUMN public.profiles.partner_preferences IS
  'E2 — stable partner-finding preferences. Read by matchmaker as a +bias. Visibility gated via account_visibility.partnerPreferences (default private). Sub-fields private-first.';

COMMENT ON COLUMN public.profiles.service_offerings IS
  'E2 — services this user offers (categories, prices, descriptions). Visibility gated via account_visibility.serviceOfferings (default public — hiding defeats the purpose).';
