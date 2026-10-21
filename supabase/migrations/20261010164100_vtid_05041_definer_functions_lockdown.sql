-- =============================================================================
-- VTID-05041 — SECURITY DEFINER functions exposed to clients (Track S / S2)
-- -----------------------------------------------------------------------------
-- docs/MULTI-TENANT-PLAN.md §3:
--  S-B  write_fact, get_current_facts, recall_at_time_range and
--       memory_facts_semantic_search are SECURITY DEFINER, take p_user_id as a
--       parameter and never check auth.uid(), yet `authenticated` could
--       EXECUTE them: any signed-in member could read and overwrite any other
--       member's memory facts via POST /rest/v1/rpc/<fn>. Their migrations
--       only covered service_role; PUBLIC's default EXECUTE was never revoked,
--       and 20260608130000_phase_c_rpc_anon_lockdown.sql then gave
--       `authenticated` EXECUTE explicitly on every DEFINER function it touched.
--  S-C  fn_consume_credits: closed by VTID-04981
--       (20261008170000_vtid_04981_consume_credits_lockdown.sql), applied
--       first. Not re-revoked here; the self-check below refuses to apply
--       while it is still open.
--  S-D  get_user_profile_by_identifier(text) returned p.email to `anon` for
--       every visible member (by handle, vitana_id or user UUID). `email` is
--       dropped from the return shape; everything else is byte-identical to
--       vitana-v1 20260721124500_public_profile_rpc_default_account_type_verification.sql.
--
-- Caller inventory (origin/main of both repos, 2026-10-10): every caller of
-- the four memory functions and of fn_consume_credits is the gateway on the
-- service role (services/memory/remember.ts, memory-facts-service.ts,
-- memory-facts-service-repository.ts, tool-recall-conversation.ts,
-- entitlement-service-repository.ts) or scripts/backfill-memory-facts.mjs.
-- No client, edge function or Python service calls them. The profile
-- function's callers (vitana-v1 PublicProfilePage, ProfilePreviewDialog,
-- useRealMatches) stay on anon / member JWT and never read `email`.
--
-- Access only for the memory functions: their bodies are untouched.
-- Idempotent: re-applying is a no-op. Checks effects, never migration rows.
-- =============================================================================

BEGIN;

-- 1) S-B: the four memory functions, every overload, service_role only.
DO $lock$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) AS fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname IN ('write_fact', 'get_current_facts', 'recall_at_time_range', 'memory_facts_semantic_search')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.fn);
  END LOOP;
END
$lock$;

-- 2) S-D: the public profile lookup without `email`. The return type changes,
--    so DROP + CREATE (grants are re-issued below).
-- definer-public: the public profile page and match previews resolve a member by handle for visitors (anon); no email.
DROP FUNCTION IF EXISTS public.get_user_profile_by_identifier(text);

CREATE FUNCTION public.get_user_profile_by_identifier(identifier text)
 RETURNS TABLE(user_id uuid, display_name text, full_name text, handle text, avatar_url text, cover_url text, bio text, location text, created_at timestamp with time zone, linkedin_url text, linkedin_headline text, linkedin_summary text, linkedin_synced_at timestamp with time zone, instagram_url text, instagram_bio text, instagram_followers_count integer, instagram_synced_at timestamp with time zone, instagram_interests text[], tiktok_url text, tiktok_bio text, tiktok_followers_count integer, tiktok_synced_at timestamp with time zone, tiktok_content_themes text[], youtube_url text, youtube_description text, youtube_subscribers_count integer, youtube_synced_at timestamp with time zone, youtube_content_categories text[], facebook_url text, facebook_bio text, facebook_synced_at timestamp with time zone, facebook_interests text[], x_url text, x_bio text, x_followers_count integer, x_synced_at timestamp with time zone, x_topics text[], longevity_archetype text, account_type text, verification_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ident text := trim(identifier, '@');
BEGIN
  IF identifier ~ '^[a-z0-9_-]+$' OR identifier LIKE '@%' THEN
    RETURN QUERY
    SELECT
      p.user_id, p.display_name, p.full_name, p.handle, p.avatar_url, p.cover_url,
      p.bio, gcp.location, p.created_at,
      p.linkedin_url, p.linkedin_headline, p.linkedin_summary, p.linkedin_synced_at,
      p.instagram_url, p.instagram_bio, p.instagram_followers_count, p.instagram_synced_at, p.instagram_interests,
      p.tiktok_url, p.tiktok_bio, p.tiktok_followers_count, p.tiktok_synced_at, p.tiktok_content_themes,
      p.youtube_url, p.youtube_description, p.youtube_subscribers_count, p.youtube_synced_at, p.youtube_content_categories,
      p.facebook_url, p.facebook_bio, p.facebook_synced_at, p.facebook_interests,
      p.x_url, p.x_bio, p.x_followers_count, p.x_synced_at, p.x_topics,
      p.longevity_archetype,
      CASE WHEN COALESCE(p.account_visibility->>'accountType', 'public') = 'public' THEN COALESCE(p.account_type, 'Community') ELSE NULL END,
      CASE WHEN COALESCE(p.account_visibility->>'verificationStatus', 'public') = 'public' THEN COALESCE(p.verification_status, 'unverified') ELSE NULL END
    FROM public.profiles p
    LEFT JOIN public.global_community_profiles gcp ON gcp.user_id = p.user_id
    WHERE p.handle = ident
    AND gcp.is_visible = true;

    IF FOUND THEN
      RETURN;
    END IF;

    RETURN QUERY
    SELECT
      p.user_id, p.display_name, p.full_name, p.handle, p.avatar_url, p.cover_url,
      p.bio, gcp.location, p.created_at,
      p.linkedin_url, p.linkedin_headline, p.linkedin_summary, p.linkedin_synced_at,
      p.instagram_url, p.instagram_bio, p.instagram_followers_count, p.instagram_synced_at, p.instagram_interests,
      p.tiktok_url, p.tiktok_bio, p.tiktok_followers_count, p.tiktok_synced_at, p.tiktok_content_themes,
      p.youtube_url, p.youtube_description, p.youtube_subscribers_count, p.youtube_synced_at, p.youtube_content_categories,
      p.facebook_url, p.facebook_bio, p.facebook_synced_at, p.facebook_interests,
      p.x_url, p.x_bio, p.x_followers_count, p.x_synced_at, p.x_topics,
      p.longevity_archetype,
      CASE WHEN COALESCE(p.account_visibility->>'accountType', 'public') = 'public' THEN COALESCE(p.account_type, 'Community') ELSE NULL END,
      CASE WHEN COALESCE(p.account_visibility->>'verificationStatus', 'public') = 'public' THEN COALESCE(p.verification_status, 'unverified') ELSE NULL END
    FROM public.profiles p
    LEFT JOIN public.global_community_profiles gcp ON gcp.user_id = p.user_id
    WHERE p.vitana_id = ident
    AND gcp.is_visible = true;

    IF FOUND THEN
      RETURN;
    END IF;
  END IF;

  IF identifier ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN QUERY
    SELECT
      p.user_id, p.display_name, p.full_name, p.handle, p.avatar_url, p.cover_url,
      p.bio, gcp.location, p.created_at,
      p.linkedin_url, p.linkedin_headline, p.linkedin_summary, p.linkedin_synced_at,
      p.instagram_url, p.instagram_bio, p.instagram_followers_count, p.instagram_synced_at, p.instagram_interests,
      p.tiktok_url, p.tiktok_bio, p.tiktok_followers_count, p.tiktok_synced_at, p.tiktok_content_themes,
      p.youtube_url, p.youtube_description, p.youtube_subscribers_count, p.youtube_synced_at, p.youtube_content_categories,
      p.facebook_url, p.facebook_bio, p.facebook_synced_at, p.facebook_interests,
      p.x_url, p.x_bio, p.x_followers_count, p.x_synced_at, p.x_topics,
      p.longevity_archetype,
      CASE WHEN COALESCE(p.account_visibility->>'accountType', 'public') = 'public' THEN COALESCE(p.account_type, 'Community') ELSE NULL END,
      CASE WHEN COALESCE(p.account_visibility->>'verificationStatus', 'public') = 'public' THEN COALESCE(p.verification_status, 'unverified') ELSE NULL END
    FROM public.profiles p
    LEFT JOIN public.global_community_profiles gcp ON gcp.user_id = p.user_id
    WHERE p.user_id = identifier::uuid
    AND gcp.is_visible = true;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_user_profile_by_identifier(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_profile_by_identifier(text) TO anon, authenticated, service_role;

-- 3) Refuse to apply (rolling everything back) unless the end state holds.
DO $check$
DECLARE
  r record;
  n integer := 0;
  consume regprocedure := to_regprocedure('public.fn_consume_credits(uuid, uuid, integer, text, text, text)');
  profile regprocedure := to_regprocedure('public.get_user_profile_by_identifier(text)');
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname IN ('write_fact', 'get_current_facts', 'recall_at_time_range', 'memory_facts_semantic_search')
  LOOP
    n := n + 1;
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE') OR has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'VTID-05041: % must not be executable by members (authenticated/anon)', r.oid::regprocedure;
    END IF;
    IF NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'VTID-05041: the gateway (service_role) must keep EXECUTE on %', r.oid::regprocedure;
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT p.proname)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE p.proname IN ('write_fact', 'get_current_facts', 'recall_at_time_range', 'memory_facts_semantic_search')) <> 4 THEN
    RAISE EXCEPTION 'VTID-05041: expected all four memory functions to exist (found % overloads)', n;
  END IF;

  IF consume IS NULL THEN
    RAISE EXCEPTION 'VTID-05041: fn_consume_credits(uuid, uuid, integer, text, text, text) not found';
  END IF;
  IF has_function_privilege('authenticated', consume, 'EXECUTE') OR has_function_privilege('anon', consume, 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05041: fn_consume_credits is still executable by members; apply VTID-04981 (20261008170000) first';
  END IF;
  IF NOT has_function_privilege('service_role', consume, 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05041: the gateway (service_role) must keep EXECUTE on fn_consume_credits';
  END IF;

  IF profile IS NULL THEN
    RAISE EXCEPTION 'VTID-05041: get_user_profile_by_identifier(text) not found';
  END IF;
  IF NOT (has_function_privilege('anon', profile, 'EXECUTE')
          AND has_function_privilege('authenticated', profile, 'EXECUTE')
          AND has_function_privilege('service_role', profile, 'EXECUTE')) THEN
    RAISE EXCEPTION 'VTID-05041: get_user_profile_by_identifier must stay executable by anon, authenticated and service_role';
  END IF;
  IF pg_get_function_result(profile) ILIKE '%email%' THEN
    RAISE EXCEPTION 'VTID-05041: get_user_profile_by_identifier must not return email';
  END IF;
END
$check$;

COMMIT;
