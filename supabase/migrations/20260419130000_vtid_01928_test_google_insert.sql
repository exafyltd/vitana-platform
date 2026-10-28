-- VTID-01928 TEST: verify a google-provider row can be stored.
--
-- This is a self-contained "migration" that inserts a synthetic social_connections
-- row with provider='google', reads it back to prove it stuck, then deletes it.
-- Any constraint failure aborts the transaction so RUN-MIGRATION.yml reports red.
--
-- Runs in a single DO block so the cleanup happens even on success.

DO $$
DECLARE
  test_tenant_id UUID := gen_random_uuid();
  test_user_id   UUID := gen_random_uuid();
  inserted_id    UUID;
  check_count    INT;
BEGIN
  INSERT INTO public.social_connections (
    tenant_id, user_id, provider,
    provider_user_id, provider_username, display_name,
    access_token, refresh_token, token_expires_at,
    scopes, profile_data,
    enrichment_status, connected_at, is_active
  ) VALUES (
    test_tenant_id, test_user_id, 'google',
    'test-sub-' || test_user_id::text, 'vtid01928-test@example.com', 'VTID-01928 Test',
    'fake-access-token', 'fake-refresh-token', NOW() + INTERVAL '1 hour',
    ARRAY['openid','email','profile','https://www.googleapis.com/auth/gmail.readonly'],
    '{}'::jsonb,
    'skipped', NOW(), true
  )
  RETURNING id INTO inserted_id;

  SELECT COUNT(*) INTO check_count
    FROM public.social_connections
   WHERE id = inserted_id AND provider = 'google';

  IF check_count <> 1 THEN
    RAISE EXCEPTION 'Inserted google row not readable (count=%, id=%)', check_count, inserted_id;
  END IF;

  DELETE FROM public.social_connections WHERE id = inserted_id;

  RAISE NOTICE 'VTID-01928 TEST PASSED: google-provider row inserted, read, and deleted (id=%)', inserted_id;
END $$;
