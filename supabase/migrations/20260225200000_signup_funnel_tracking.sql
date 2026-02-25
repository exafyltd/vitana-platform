-- =============================================================================
-- Migration: Signup Funnel Tracking & Abandoned Registration Recovery
-- =============================================================================
-- Problem: Users start the registration process but fail or abandon at various
-- stages. The XFI team has zero visibility into who tried to sign up, where
-- they got stuck, and no way to re-engage them.
--
-- Solution:
--   1. signup_attempts: Tracks every signup attempt BEFORE it hits Supabase Auth,
--      capturing failures (bad password, network errors, etc.)
--   2. signup_funnel: A view that joins auth.users → app_users → user_tenants →
--      live_rooms → user_notifications to show exactly where each user is in the
--      onboarding pipeline
--   3. onboarding_invitations: Tracks outreach to abandoned users (email, live
--      room invitations, meetup invitations)
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. SIGNUP_ATTEMPTS: Capture every registration attempt
-- =============================================================================
-- This table is written to by a PUBLIC endpoint (no auth required) so the
-- frontend can log attempts before calling supabase.auth.signUp().
-- If the Supabase signup succeeds, the auth_user_id is backfilled.

CREATE TABLE IF NOT EXISTS public.signup_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    tenant_slug TEXT,                          -- which landing page (vitana, maxina, etc.)
    display_name TEXT,
    source TEXT DEFAULT 'web',                 -- web, mobile, api
    status TEXT NOT NULL DEFAULT 'attempted',  -- attempted | succeeded | failed | email_pending | confirmed | onboarded
    failure_reason TEXT,                       -- e.g. 'weak_password', 'duplicate_email', 'network_error', 'unknown'
    auth_user_id UUID,                        -- backfilled when Supabase signup succeeds
    ip_address INET,
    user_agent TEXT,
    metadata JSONB DEFAULT '{}',              -- additional context (UTM params, referrer, etc.)
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    succeeded_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    onboarded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_signup_attempts_email ON public.signup_attempts (email);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_status ON public.signup_attempts (status);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_tenant ON public.signup_attempts (tenant_slug);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_attempted_at ON public.signup_attempts (attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_auth_user ON public.signup_attempts (auth_user_id) WHERE auth_user_id IS NOT NULL;

-- RLS: Service role can do everything, anon can only INSERT (for the public tracking endpoint)
ALTER TABLE public.signup_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS signup_attempts_insert_anon ON public.signup_attempts;
CREATE POLICY signup_attempts_insert_anon ON public.signup_attempts
    FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS signup_attempts_all_service ON public.signup_attempts;
CREATE POLICY signup_attempts_all_service ON public.signup_attempts
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS signup_attempts_select_authenticated ON public.signup_attempts;
CREATE POLICY signup_attempts_select_authenticated ON public.signup_attempts
    FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.signup_attempts IS 'Tracks every signup attempt for funnel analysis and abandoned registration recovery';

-- =============================================================================
-- 2. ONBOARDING_INVITATIONS: Track outreach to abandoned/stuck users
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.onboarding_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signup_attempt_id UUID REFERENCES public.signup_attempts(id) ON DELETE SET NULL,
    email TEXT NOT NULL,
    auth_user_id UUID,
    tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
    invitation_type TEXT NOT NULL,             -- 'email' | 'live_room' | 'meetup' | 'push_notification'
    status TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'sent' | 'accepted' | 'expired' | 'declined'
    live_room_id UUID,                        -- if invitation_type = 'live_room', references the onboarding room
    meetup_id UUID,                           -- if invitation_type = 'meetup'
    message TEXT,                             -- personalized message
    sent_by UUID,                             -- which team member sent this
    sent_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_inv_email ON public.onboarding_invitations (email);
CREATE INDEX IF NOT EXISTS idx_onboarding_inv_status ON public.onboarding_invitations (status);
CREATE INDEX IF NOT EXISTS idx_onboarding_inv_type ON public.onboarding_invitations (invitation_type);

ALTER TABLE public.onboarding_invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS onboarding_inv_all_service ON public.onboarding_invitations;
CREATE POLICY onboarding_inv_all_service ON public.onboarding_invitations
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS onboarding_inv_select_authenticated ON public.onboarding_invitations;
CREATE POLICY onboarding_inv_select_authenticated ON public.onboarding_invitations
    FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.onboarding_invitations IS 'Tracks outreach to users who abandoned or got stuck during signup/onboarding';

-- =============================================================================
-- 3. SIGNUP_FUNNEL VIEW: Single pane of glass for the XFI team
-- =============================================================================
-- Joins auth.users with all downstream tables to show exactly where each user
-- is in the onboarding pipeline.

CREATE OR REPLACE VIEW public.signup_funnel AS
SELECT
    au.id AS auth_user_id,
    au.email,
    au.raw_user_meta_data ->> 'display_name' AS display_name,
    au.raw_user_meta_data ->> 'tenant_slug' AS tenant_slug,
    au.created_at AS registered_at,
    au.email_confirmed_at,
    au.last_sign_in_at,

    -- Onboarding stage calculation
    CASE
        WHEN au.email_confirmed_at IS NULL THEN 'email_pending'
        WHEN pu.user_id IS NULL THEN 'provisioning_failed'
        WHEN ut.user_id IS NULL THEN 'no_tenant'
        WHEN lr.host_user_id IS NULL THEN 'no_live_room'
        WHEN au.last_sign_in_at IS NULL THEN 'never_logged_in'
        WHEN wn.id IS NULL THEN 'no_welcome_sent'
        ELSE 'onboarded'
    END AS onboarding_stage,

    -- Boolean flags for each step
    (au.email_confirmed_at IS NOT NULL) AS email_confirmed,
    (pu.user_id IS NOT NULL) AS has_app_user,
    (ut.user_id IS NOT NULL) AS has_tenant_membership,
    (lr.host_user_id IS NOT NULL) AS has_live_room,
    (au.last_sign_in_at IS NOT NULL) AS has_logged_in,
    (wn.id IS NOT NULL) AS welcome_notification_sent,
    (prof.avatar_url IS NOT NULL) AS has_avatar,
    (prof.bio IS NOT NULL AND prof.bio != '') AS has_bio,

    -- Time metrics
    au.last_sign_in_at - au.created_at AS time_to_first_login,
    EXTRACT(EPOCH FROM (NOW() - au.created_at)) / 86400.0 AS days_since_registration,

    -- Counts
    COALESCE(notif_count.total, 0) AS total_notifications,
    COALESCE(attendance.sessions_joined, 0) AS live_sessions_joined,

    -- Tenant info
    t.slug AS resolved_tenant_slug,
    t.name AS tenant_name,

    -- Latest invitation info
    inv.latest_invitation_type,
    inv.latest_invitation_status,
    inv.latest_invitation_at

FROM auth.users au

-- app_users (provisioned user record)
LEFT JOIN public.app_users pu ON pu.user_id = au.id

-- Profile data
LEFT JOIN public.app_users prof ON prof.user_id = au.id

-- user_tenants (tenant membership)
LEFT JOIN public.user_tenants ut ON ut.user_id = au.id AND ut.is_primary = true

-- Resolved tenant
LEFT JOIN public.tenants t ON t.id = ut.tenant_id

-- Live room (auto-created on tenant membership)
LEFT JOIN public.live_rooms lr ON lr.host_user_id = au.id

-- Welcome notification
LEFT JOIN public.user_notifications wn ON wn.user_id = au.id AND wn.type = 'welcome_to_vitana'

-- Notification count
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS total
    FROM public.user_notifications un
    WHERE un.user_id = au.id
) notif_count ON true

-- Live room attendance count
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS sessions_joined
    FROM public.live_room_attendance lra
    WHERE lra.user_id = au.id
) attendance ON true

-- Latest onboarding invitation
LEFT JOIN LATERAL (
    SELECT
        oi.invitation_type AS latest_invitation_type,
        oi.status AS latest_invitation_status,
        oi.created_at AS latest_invitation_at
    FROM public.onboarding_invitations oi
    WHERE oi.email = au.email
    ORDER BY oi.created_at DESC
    LIMIT 1
) inv ON true

ORDER BY au.created_at DESC;

COMMENT ON VIEW public.signup_funnel IS 'Unified view of user onboarding progress: registration → email confirm → provisioning → tenant → live room → welcome. Used by XFI team to track and recover abandoned signups.';

-- Grant access to the view
GRANT SELECT ON public.signup_funnel TO service_role;
GRANT SELECT ON public.signup_funnel TO authenticated;

-- =============================================================================
-- 4. AUTO-UPDATE signup_attempts when auth.users INSERT succeeds
-- =============================================================================
-- When provision_platform_user fires (after auth.users INSERT), we also update
-- any matching signup_attempt to status='succeeded'.

CREATE OR REPLACE FUNCTION public.update_signup_attempt_on_auth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.signup_attempts
    SET
        status = 'succeeded',
        auth_user_id = NEW.id,
        succeeded_at = NOW(),
        updated_at = NOW()
    WHERE email = NEW.email
      AND status = 'attempted'
      AND auth_user_id IS NULL;

    RETURN NEW;
END;
$$;

-- This trigger fires AFTER INSERT on auth.users, after provision_platform_user
DROP TRIGGER IF EXISTS on_auth_user_update_signup_attempt ON auth.users;
CREATE TRIGGER on_auth_user_update_signup_attempt
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.update_signup_attempt_on_auth();

COMMENT ON FUNCTION public.update_signup_attempt_on_auth IS 'Auto-updates signup_attempts status when a user successfully registers in auth.users';

-- =============================================================================
-- 5. AUTO-UPDATE signup_attempts when email is confirmed
-- =============================================================================

CREATE OR REPLACE FUNCTION public.update_signup_attempt_on_confirm()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Only fire when email_confirmed_at changes from NULL to non-NULL
    IF OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL THEN
        UPDATE public.signup_attempts
        SET
            status = 'confirmed',
            confirmed_at = NEW.email_confirmed_at,
            updated_at = NOW()
        WHERE auth_user_id = NEW.id
          AND status IN ('attempted', 'succeeded', 'email_pending');
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_email_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_email_confirmed
    AFTER UPDATE ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.update_signup_attempt_on_confirm();

COMMENT ON FUNCTION public.update_signup_attempt_on_confirm IS 'Auto-updates signup_attempts when user confirms their email';

COMMIT;
