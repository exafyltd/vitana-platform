-- ============================================================
-- Signup Funnel Tracking (Admin System)
-- ============================================================
-- Tables for tracking user registration attempts, onboarding
-- progress, and admin outreach to stuck users.
-- ============================================================

-- ── signup_attempts ─────────────────────────────────────────
-- Captures every registration attempt BEFORE Supabase Auth
-- completes. Frontend calls POST /api/v1/admin/signups/log-attempt
-- at the start of signup flow.

CREATE TABLE IF NOT EXISTS signup_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES public.tenants(tenant_id),
  email         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'started'
                CHECK (status IN ('started','email_sent','verified','profile_created','onboarded','abandoned')),
  auth_user_id  UUID,
  metadata      JSONB DEFAULT '{}',
  ip_address    INET,
  user_agent    TEXT,
  started_at    TIMESTAMPTZ DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signup_attempts_tenant ON signup_attempts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_email ON signup_attempts(email);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_status ON signup_attempts(status);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_started_at ON signup_attempts(started_at DESC);

-- RLS: service_role can read/write all; no direct user access
ALTER TABLE signup_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access_signup_attempts"
  ON signup_attempts FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── onboarding_invitations ──────────────────────────────────
-- Tracks admin outreach to users who got stuck during signup.

CREATE TABLE IF NOT EXISTS onboarding_invitations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES public.tenants(tenant_id),
  signup_attempt_id   UUID REFERENCES public.signup_attempts(id),
  target_user_id      UUID,
  email               TEXT NOT NULL,
  invited_by          UUID NOT NULL,
  type                TEXT NOT NULL DEFAULT 'email'
                      CHECK (type IN ('email','sms','push','live_room')),
  status              TEXT NOT NULL DEFAULT 'sent'
                      CHECK (status IN ('sent','opened','clicked','converted','expired')),
  message             TEXT,
  sent_at             TIMESTAMPTZ DEFAULT now(),
  opened_at           TIMESTAMPTZ,
  clicked_at          TIMESTAMPTZ,
  converted_at        TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ DEFAULT (now() + interval '7 days'),
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_inv_tenant ON onboarding_invitations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_inv_email ON onboarding_invitations(email);
CREATE INDEX IF NOT EXISTS idx_onboarding_inv_status ON onboarding_invitations(status);

ALTER TABLE onboarding_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access_onboarding_inv"
  ON onboarding_invitations FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── signup_funnel view ──────────────────────────────────────
-- Joins signup_attempts through auth.users, app_users, and
-- user_tenants for a complete funnel visualization.

CREATE OR REPLACE VIEW signup_funnel AS
SELECT
  sa.id AS attempt_id,
  sa.tenant_id,
  sa.email,
  sa.status AS attempt_status,
  sa.started_at,
  sa.completed_at,
  sa.metadata,
  -- Auth stage
  au.id AS auth_user_id,
  au.created_at AS auth_created_at,
  au.email_confirmed_at,
  au.last_sign_in_at,
  -- Profile stage
  ap.user_id AS app_user_id,
  ap.display_name,
  ap.created_at AS profile_created_at,
  -- Tenant membership stage
  ut.active_role,
  ut.is_primary,
  ut.created_at AS membership_created_at,
  -- Derived funnel stage
  CASE
    WHEN ut.user_id IS NOT NULL THEN 'onboarded'
    WHEN ap.user_id IS NOT NULL THEN 'profile_created'
    WHEN au.email_confirmed_at IS NOT NULL THEN 'verified'
    WHEN au.id IS NOT NULL THEN 'email_sent'
    ELSE sa.status
  END AS funnel_stage
FROM signup_attempts sa
LEFT JOIN auth.users au ON au.email = sa.email
LEFT JOIN app_users ap ON ap.user_id = au.id
LEFT JOIN user_tenants ut ON ut.user_id = au.id AND ut.tenant_id = sa.tenant_id;

-- ── Auto-update trigger ─────────────────────────────────────
-- When a new auth.users row is created, try to update any
-- matching signup_attempt to reflect progress.

CREATE OR REPLACE FUNCTION update_signup_attempt_on_auth_user()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE signup_attempts
  SET
    auth_user_id = NEW.id,
    status = CASE
      WHEN status = 'started' THEN 'email_sent'
      ELSE status
    END,
    updated_at = now()
  WHERE email = NEW.email
    AND status IN ('started', 'email_sent')
    AND auth_user_id IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Only create if not exists (avoid duplicate trigger errors)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_update_signup_attempt_on_auth'
  ) THEN
    CREATE TRIGGER trg_update_signup_attempt_on_auth
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION update_signup_attempt_on_auth_user();
  END IF;
END;
$$;

-- ── Auto-update on email confirmation ────────────────────────
CREATE OR REPLACE FUNCTION update_signup_attempt_on_email_confirm()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL THEN
    UPDATE signup_attempts
    SET
      status = 'verified',
      updated_at = now()
    WHERE auth_user_id = NEW.id
      AND status IN ('started', 'email_sent');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_update_signup_on_email_confirm'
  ) THEN
    CREATE TRIGGER trg_update_signup_on_email_confirm
      AFTER UPDATE ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION update_signup_attempt_on_email_confirm();
  END IF;
END;
$$;

-- ── updated_at trigger for signup_attempts ───────────────────
CREATE OR REPLACE FUNCTION update_signup_attempts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_signup_attempts_updated_at'
  ) THEN
    CREATE TRIGGER trg_signup_attempts_updated_at
      BEFORE UPDATE ON signup_attempts
      FOR EACH ROW
      EXECUTE FUNCTION update_signup_attempts_updated_at();
  END IF;
END;
$$;
