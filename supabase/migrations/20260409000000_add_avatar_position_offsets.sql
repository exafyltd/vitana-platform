-- ===========================================================================
-- Add avatar position offset columns for profile picture repositioning
-- Values are 0-100 representing percentage (50 = center, default)
-- ===========================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'app_users'
        AND column_name = 'avatar_offset_x'
    ) THEN
        ALTER TABLE public.app_users ADD COLUMN avatar_offset_x SMALLINT NOT NULL DEFAULT 50;
        COMMENT ON COLUMN public.app_users.avatar_offset_x IS 'Horizontal position % for avatar crop (0=left, 50=center, 100=right)';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'app_users'
        AND column_name = 'avatar_offset_y'
    ) THEN
        ALTER TABLE public.app_users ADD COLUMN avatar_offset_y SMALLINT NOT NULL DEFAULT 50;
        COMMENT ON COLUMN public.app_users.avatar_offset_y IS 'Vertical position % for avatar crop (0=top, 50=center, 100=bottom)';
    END IF;
END $$;

-- ===========================================================================
-- Update get_user_profile to include avatar offsets
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
        'avatar_offset_x', au.avatar_offset_x,
        'avatar_offset_y', au.avatar_offset_y,
        'bio', au.bio,
        'created_at', au.created_at
    )
    INTO v_profile
    FROM public.app_users au
    WHERE au.user_id = p_user_id;

    IF v_profile IS NULL THEN
        RETURN jsonb_build_object(
            'user_id', p_user_id,
            'email', NULL,
            'display_name', NULL,
            'avatar_url', NULL,
            'avatar_offset_x', 50,
            'avatar_offset_y', 50,
            'bio', NULL
        );
    END IF;

    RETURN v_profile;
END;
$$;

-- ===========================================================================
-- Update update_user_profile to accept avatar offsets
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.update_user_profile(
    p_display_name TEXT DEFAULT NULL,
    p_avatar_url TEXT DEFAULT NULL,
    p_bio TEXT DEFAULT NULL,
    p_avatar_offset_x SMALLINT DEFAULT NULL,
    p_avatar_offset_y SMALLINT DEFAULT NULL
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
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    INSERT INTO public.app_users (user_id, email, display_name, avatar_url, bio, avatar_offset_x, avatar_offset_y)
    SELECT
        v_user_id,
        COALESCE((SELECT email FROM auth.users WHERE id = v_user_id), 'unknown@example.com'),
        p_display_name,
        p_avatar_url,
        p_bio,
        COALESCE(p_avatar_offset_x, 50),
        COALESCE(p_avatar_offset_y, 50)
    ON CONFLICT (user_id) DO UPDATE SET
        display_name = COALESCE(p_display_name, app_users.display_name),
        avatar_url = COALESCE(p_avatar_url, app_users.avatar_url),
        bio = COALESCE(p_bio, app_users.bio),
        avatar_offset_x = COALESCE(p_avatar_offset_x, app_users.avatar_offset_x),
        avatar_offset_y = COALESCE(p_avatar_offset_y, app_users.avatar_offset_y),
        updated_at = NOW();

    SELECT jsonb_build_object(
        'ok', true,
        'profile', get_user_profile(v_user_id)
    ) INTO v_result;

    RETURN v_result;
END;
$$;
