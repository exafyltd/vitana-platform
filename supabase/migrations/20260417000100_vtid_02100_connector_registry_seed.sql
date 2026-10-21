-- Migration: 20260417000100_vtid_02100_connector_registry_seed.sql
-- Purpose: Seed connector_registry with the providers we support. Terra is
--          the aggregator that unlocks 20+ wearables via one integration.

INSERT INTO public.connector_registry (id, category, display_name, description, auth_type, capabilities, default_scopes, underlying_providers, enabled, requires_ios_companion, docs_url)
VALUES
  -- ========== Wearable aggregator ==========
  ('terra', 'aggregator', 'Terra',
   'Health aggregator that unlocks Apple Health + Apple Watch (via iOS companion) and 20+ other wearables (Fitbit, Oura, Garmin, Whoop, Google Fit, Samsung Health, Strava, MyFitnessPal) via one integration.',
   'oauth2',
   ARRAY['sleep.read','activity.read','workouts.read','hr.read','hrv.read','body.read'],
   ARRAY['SLEEP','DAILY','ACTIVITY','BODY'],
   ARRAY['apple_health','fitbit','oura','garmin','whoop','google_fit','samsung_health','strava','myfitnesspal','polar','withings','peloton'],
   TRUE, TRUE,
   'https://docs.tryterra.co/'),

  -- ========== Direct wearable providers (fallback if not using Terra) ==========
  ('fitbit', 'wearable', 'Fitbit',
   'Fitbit OAuth2 direct integration. Use when not using Terra aggregator.',
   'oauth2',
   ARRAY['sleep.read','activity.read','hr.read'],
   ARRAY['sleep','activity','heartrate'],
   NULL,
   FALSE, FALSE,
   'https://dev.fitbit.com/'),

  ('oura', 'wearable', 'Oura Ring',
   'Oura direct OAuth2. Use when not using Terra.',
   'oauth2',
   ARRAY['sleep.read','activity.read','hrv.read','readiness.read'],
   ARRAY['daily','personal'],
   NULL, FALSE, FALSE,
   'https://cloud.ouraring.com/v2/docs'),

  -- ========== Existing social providers (for registry visibility; code still lives in social-connect-service) ==========
  ('instagram', 'social', 'Instagram', 'Meta Instagram Basic Display + Graph API', 'oauth2',
   ARRAY['profile.read','media.read'], ARRAY['user_profile','user_media'], NULL, TRUE, FALSE, NULL),
  ('facebook', 'social', 'Facebook', 'Meta Facebook Graph API', 'oauth2',
   ARRAY['profile.read','posts.read'], ARRAY['public_profile','user_posts'], NULL, TRUE, FALSE, NULL),
  ('tiktok', 'social', 'TikTok', 'TikTok Login Kit', 'oauth2',
   ARRAY['profile.read','video.read'], ARRAY['user.info.basic','video.list'], NULL, TRUE, FALSE, NULL),
  ('youtube', 'social', 'YouTube', 'YouTube Data API v3', 'oauth2',
   ARRAY['profile.read','channel.read'], ARRAY['youtube.readonly'], NULL, TRUE, FALSE, NULL),
  ('linkedin', 'social', 'LinkedIn', 'LinkedIn API v2', 'oauth2',
   ARRAY['profile.read'], ARRAY['openid','profile','email'], NULL, TRUE, FALSE, NULL),
  ('twitter', 'social', 'X (Twitter)', 'Twitter/X OAuth2', 'oauth2',
   ARRAY['profile.read','tweets.read'], ARRAY['tweet.read','users.read'], NULL, TRUE, FALSE, NULL)

ON CONFLICT (id) DO UPDATE
  SET description = EXCLUDED.description,
      capabilities = EXCLUDED.capabilities,
      default_scopes = EXCLUDED.default_scopes,
      underlying_providers = EXCLUDED.underlying_providers,
      updated_at = NOW();
