-- Migration: 20260417010000_vtid_02100_connector_registry_update.sql
-- Purpose: Add Vital + Strava to connector_registry, and refine existing
--          Fitbit/Oura rows. These are all wired to live code connectors
--          under services/gateway/src/connectors/wearable/*.

INSERT INTO public.connector_registry (id, category, display_name, description, auth_type, capabilities, default_scopes, underlying_providers, enabled, requires_ios_companion, docs_url)
VALUES
  -- Vital: aggregator alternative to Terra, free up to 100 connected users
  ('vital', 'aggregator', 'Vital',
   'Health aggregator (tryvital.io). Free tier covers up to 100 connected users. Unlocks Apple Health + Apple Watch (via iOS SDK), Fitbit, Oura, Garmin, Whoop, Google Fit, Withings, Polar, Peloton, Strava, Samsung Health + others via the Vital Link widget.',
   'sdk_bridge',
   ARRAY['sleep.read','activity.read','workouts.read','hr.read','hrv.read','body.read'],
   ARRAY['sleep','activity','workouts','body'],
   ARRAY['apple_health','fitbit','oura','garmin','whoop','google_fit','samsung_health','strava','myfitnesspal','polar','withings','peloton','freestyle_libre'],
   TRUE, TRUE,
   'https://docs.tryvital.io/'),

  -- Strava direct (free, workout-focused)
  ('strava', 'wearable', 'Strava',
   'Strava OAuth2 + webhook. Workout-focused — good for runners, cyclists, swimmers. Free for non-commercial.',
   'oauth2',
   ARRAY['workouts.read','activity.read','profile.read'],
   ARRAY['read','activity:read_all','profile:read_all'],
   NULL,
   FALSE, FALSE,
   'https://developers.strava.com/')

ON CONFLICT (id) DO UPDATE
  SET description = EXCLUDED.description,
      capabilities = EXCLUDED.capabilities,
      default_scopes = EXCLUDED.default_scopes,
      underlying_providers = EXCLUDED.underlying_providers,
      requires_ios_companion = EXCLUDED.requires_ios_companion,
      docs_url = EXCLUDED.docs_url,
      updated_at = NOW();

-- Refine existing Fitbit + Oura entries to match the real connector capabilities
UPDATE public.connector_registry
   SET description = 'Fitbit OAuth2 direct. Free API (150 req/hr/user). Covers sleep, activity (steps, calories, distance), heart rate.',
       capabilities = ARRAY['sleep.read','activity.read','hr.read','profile.read'],
       default_scopes = ARRAY['sleep','activity','heartrate','profile','weight'],
       docs_url = 'https://dev.fitbit.com/build/reference/web-api/',
       updated_at = NOW()
 WHERE id = 'fitbit';

UPDATE public.connector_registry
   SET description = 'Oura Ring OAuth2 direct. Free personal/dev tier (500 req/day/user). Best-in-class sleep, HRV, readiness.',
       capabilities = ARRAY['sleep.read','activity.read','hrv.read','readiness.read','workouts.read'],
       default_scopes = ARRAY['personal','daily','heartrate','workout','session'],
       docs_url = 'https://cloud.ouraring.com/v2/docs',
       updated_at = NOW()
 WHERE id = 'oura';

-- Mark Terra as "premium alternative" (still enabled but lower priority now)
UPDATE public.connector_registry
   SET description = 'Health aggregator (tryterra.co). Commercial tier ($499+/month). Lower priority than Vital for new deploys.',
       updated_at = NOW()
 WHERE id = 'terra';
