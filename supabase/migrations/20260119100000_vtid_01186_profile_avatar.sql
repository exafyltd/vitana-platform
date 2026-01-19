-- ===========================================================================
-- VTID-01186: Add avatar_url to app_users for profile display
-- ===========================================================================
--
-- Purpose: Enable storing user avatar URLs for profile display in UI
-- This supports the vitana-v1 (lovable) profile modal design
--
-- Changes:
-- 1. Add avatar_url column to app_users table
-- 2. Add bio column for future profile expansion
-- ===========================================================================

-- Add avatar_url column if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'app_users'
        AND column_name = 'avatar_url'
    ) THEN
        ALTER TABLE public.app_users ADD COLUMN avatar_url TEXT;
        COMMENT ON COLUMN public.app_users.avatar_url IS 'VTID-01186: URL to user avatar image';
    END IF;
END $$;

-- Add bio column for future use
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'app_users'
        AND column_name = 'bio'
    ) THEN
        ALTER TABLE public.app_users ADD COLUMN bio TEXT;
        COMMENT ON COLUMN public.app_users.bio IS 'VTID-01186: User bio/description';
    END IF;
END $$;

-- ===========================================================================
-- Function: get_user_profile(p_user_id)
-- Returns user profile data for the given user_id
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.get_user_profile(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile JSONB;
BEGIN
    SELECT jsonb_build_object(
        'user_id', au.user_id,
        'email', au.email,
        'display_name', au.display_name,
        'avatar_url', au.avatar_url,
        'bio', au.bio,
        'created_at', au.created_at
    )
    INTO v_profile
    FROM public.app_users au
    WHERE au.user_id = p_user_id;

    -- If no profile found, return minimal object
    IF v_profile IS NULL THEN
        RETURN jsonb_build_object(
            'user_id', p_user_id,
            'email', NULL,
            'display_name', NULL,
            'avatar_url', NULL,
            'bio', NULL
        );
    END IF;

    RETURN v_profile;
END;
$$;

COMMENT ON FUNCTION public.get_user_profile IS 'VTID-01186: Get user profile data by user_id';

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.get_user_profile TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_profile TO service_role;

-- ===========================================================================
-- Function: update_user_profile(p_display_name, p_avatar_url, p_bio)
-- Updates the current user's profile
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.update_user_profile(
    p_display_name TEXT DEFAULT NULL,
    p_avatar_url TEXT DEFAULT NULL,
    p_bio TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_result JSONB;
BEGIN
    -- Get current user ID
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Upsert the profile
    INSERT INTO public.app_users (user_id, email, display_name, avatar_url, bio)
    SELECT
        v_user_id,
        COALESCE((SELECT email FROM auth.users WHERE id = v_user_id), 'unknown@example.com'),
        p_display_name,
        p_avatar_url,
        p_bio
    ON CONFLICT (user_id) DO UPDATE SET
        display_name = COALESCE(p_display_name, app_users.display_name),
        avatar_url = COALESCE(p_avatar_url, app_users.avatar_url),
        bio = COALESCE(p_bio, app_users.bio),
        updated_at = NOW();

    -- Return updated profile
    SELECT jsonb_build_object(
        'ok', true,
        'profile', get_user_profile(v_user_id)
    ) INTO v_result;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.update_user_profile IS 'VTID-01186: Update current user profile';

GRANT EXECUTE ON FUNCTION public.update_user_profile TO authenticated;
