-- VTID-05041 test fixture: reproduces the live (2026-10-10) exposure of the
-- S2 functions on a throwaway local Postgres, for
-- scripts/ci/test-vtid-05041-definer-lockdown.sh.
--  * the four memory functions as SECURITY DEFINER stubs with the exact live
--    identity signatures, granted to `authenticated` (as live) with PUBLIC's
--    default EXECUTE left in place (worst case);
--  * fn_consume_credits as a stub with its live signature, granted to
--    `authenticated` as VTID-03107 did (VTID-04981 then revokes it);
--  * minimal profiles / global_community_profiles and the real
--    get_user_profile_by_identifier from vitana-v1
--    20260721124500_public_profile_rpc_default_account_type_verification.sql
--    (copied verbatim, with its anon grant).
-- Bodies of the stubs are irrelevant: the migration changes access only.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- pgvector is not installed on CI runners; a domain keeps the identity
-- signature spelled `vector` as it is live.
CREATE DOMAIN public.vector AS double precision[];

CREATE FUNCTION public.write_fact(p_tenant_id uuid, p_user_id uuid, p_fact_key text, p_fact_value text,
  p_entity text DEFAULT 'self', p_fact_value_type text DEFAULT 'text', p_provenance_source text DEFAULT 'user_stated',
  p_provenance_utterance_id uuid DEFAULT NULL, p_provenance_confidence numeric DEFAULT 0.9, p_thread_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT gen_random_uuid() $$;

CREATE FUNCTION public.get_current_facts(p_tenant_id uuid, p_user_id uuid, p_entity text DEFAULT NULL, p_fact_keys text[] DEFAULT NULL)
RETURNS TABLE(id uuid, entity text, fact_key text, fact_value text, fact_value_type text, provenance_source text,
  provenance_confidence numeric, extracted_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::numeric, NULL::timestamptz WHERE false $$;

CREATE FUNCTION public.recall_at_time_range(p_user_id uuid, p_from timestamptz, p_to timestamptz, p_query text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT '{}'::jsonb $$;

CREATE FUNCTION public.memory_facts_semantic_search(p_query_embedding public.vector, p_top_k integer, p_tenant_id uuid,
  p_user_id uuid, p_entity text DEFAULT NULL, p_min_confidence numeric DEFAULT 0.5)
RETURNS TABLE(id uuid, fact_key text, fact_value text, entity text, fact_value_type text, provenance_source text,
  provenance_confidence numeric, extracted_at timestamptz, similarity_score double precision)
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::numeric, NULL::timestamptz, NULL::double precision WHERE false $$;

GRANT EXECUTE ON FUNCTION public.write_fact(uuid, uuid, text, text, text, text, text, uuid, numeric, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_current_facts(uuid, uuid, text, text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recall_at_time_range(uuid, timestamptz, timestamptz, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.memory_facts_semantic_search(public.vector, integer, uuid, uuid, text, numeric) TO authenticated, service_role;

CREATE FUNCTION public.fn_consume_credits(p_tenant_id uuid, p_user_id uuid, p_amount integer, p_bucket text,
  p_feature_key text, p_idempotency_key text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT '{"ok":true}'::jsonb $$;
GRANT EXECUTE ON FUNCTION public.fn_consume_credits(uuid, uuid, integer, text, text, text) TO service_role, authenticated;

CREATE TABLE public.profiles (
  user_id uuid PRIMARY KEY, display_name text, full_name text, handle text, vitana_id text, avatar_url text, cover_url text,
  bio text, email text, created_at timestamptz DEFAULT now(),
  linkedin_url text, linkedin_headline text, linkedin_summary text, linkedin_synced_at timestamptz,
  instagram_url text, instagram_bio text, instagram_followers_count integer, instagram_synced_at timestamptz, instagram_interests text[],
  tiktok_url text, tiktok_bio text, tiktok_followers_count integer, tiktok_synced_at timestamptz, tiktok_content_themes text[],
  youtube_url text, youtube_description text, youtube_subscribers_count integer, youtube_synced_at timestamptz, youtube_content_categories text[],
  facebook_url text, facebook_bio text, facebook_synced_at timestamptz, facebook_interests text[],
  x_url text, x_bio text, x_followers_count integer, x_synced_at timestamptz, x_topics text[],
  longevity_archetype text, account_type text, verification_status text, account_visibility jsonb
);
CREATE TABLE public.global_community_profiles (user_id uuid PRIMARY KEY, location text, is_visible boolean);

INSERT INTO public.profiles (user_id, display_name, handle, vitana_id, email)
VALUES ('00000000-0000-0000-0000-0000000050a1', 'Visible Member', 'visible_member', 'vm0001', 'visible@example.test'),
       ('00000000-0000-0000-0000-0000000050a2', 'Hidden Member', 'hidden_member', 'hm0002', 'hidden@example.test');
INSERT INTO public.global_community_profiles (user_id, location, is_visible)
VALUES ('00000000-0000-0000-0000-0000000050a1', 'Belgrade', true),
       ('00000000-0000-0000-0000-0000000050a2', 'Berlin', false);

-- get_user_profile_by_identifier as vitana-v1 20260721124500 shipped it (live 2026-10-10).
CREATE FUNCTION public.get_user_profile_by_identifier(identifier text)
 RETURNS TABLE(user_id uuid, display_name text, full_name text, handle text, avatar_url text, cover_url text, bio text, email text, location text, created_at timestamp with time zone, linkedin_url text, linkedin_headline text, linkedin_summary text, linkedin_synced_at timestamp with time zone, instagram_url text, instagram_bio text, instagram_followers_count integer, instagram_synced_at timestamp with time zone, instagram_interests text[], tiktok_url text, tiktok_bio text, tiktok_followers_count integer, tiktok_synced_at timestamp with time zone, tiktok_content_themes text[], youtube_url text, youtube_description text, youtube_subscribers_count integer, youtube_synced_at timestamp with time zone, youtube_content_categories text[], facebook_url text, facebook_bio text, facebook_synced_at timestamp with time zone, facebook_interests text[], x_url text, x_bio text, x_followers_count integer, x_synced_at timestamp with time zone, x_topics text[], longevity_archetype text, account_type text, verification_status text)
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
      p.bio, p.email, gcp.location, p.created_at,
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
      p.bio, p.email, gcp.location, p.created_at,
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
      p.bio, p.email, gcp.location, p.created_at,
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

GRANT EXECUTE ON FUNCTION public.get_user_profile_by_identifier(text) TO anon, authenticated, service_role;
