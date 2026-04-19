-- VTID-01928 VERIFY: inspect the current state of every google-provider
-- connection in social_connections. Reports one NOTICE per row with:
--   - user_id prefix (8 chars)
--   - provider_username (the Google email)
--   - access_token length + first 6 chars (proves token shape, not value)
--   - refresh_token length (non-zero => Google returned one)
--   - scopes granted
--   - seconds until token expiry (negative => already stale)
--   - connected_at age
--
-- Read-only: no INSERT/UPDATE/DELETE.
DO $$
DECLARE
  r RECORD;
  total INT := 0;
BEGIN
  FOR r IN
    SELECT
      user_id,
      provider_username,
      COALESCE(length(access_token), 0)                  AS at_len,
      COALESCE(substr(access_token, 1, 6), '')           AS at_prefix,
      COALESCE(length(refresh_token), 0)                 AS rt_len,
      scopes,
      EXTRACT(EPOCH FROM (token_expires_at - NOW()))::INT AS expires_in_sec,
      connected_at,
      is_active,
      enrichment_status
    FROM public.social_connections
    WHERE provider = 'google'
    ORDER BY connected_at DESC
    LIMIT 20
  LOOP
    total := total + 1;
    RAISE NOTICE
      'google-conn %: user=%… email=% access_token=%chars(%…) refresh_token=%chars scopes=% expires_in=%s connected=% active=% status=%',
      total,
      substring(r.user_id::text, 1, 8),
      r.provider_username,
      r.at_len, r.at_prefix,
      r.rt_len,
      r.scopes,
      r.expires_in_sec,
      r.connected_at,
      r.is_active,
      r.enrichment_status;
  END LOOP;

  IF total = 0 THEN
    RAISE NOTICE 'VTID-01928 VERIFY: no google-provider rows in social_connections';
  ELSE
    RAISE NOTICE 'VTID-01928 VERIFY: % google-provider row(s) found', total;
  END IF;
END $$;
