-- VTID-01942 (PR 2/3): user_capability_preferences + capability_play_log
--
-- Two tables backing the routing-preference rules in capabilities/index.ts:
--
-- user_capability_preferences
--   One row per (user, capability) that records which connector the user
--   wants to use. `set_method` records whether it was explicit (user said
--   "always use YouTube Music") or learned (auto-suggested after N plays
--   and user confirmed).
--
-- capability_play_log
--   Lightweight append-only trail of successful capability invocations.
--   Used to compute "the user has chosen YouTube Music 3 times in a row →
--   suggest making it the default". Rotated (keep ~30 rows per user per
--   capability) via a trimming trigger or periodic job — not critical for
--   v1.
--
-- Idempotent — safe to apply multiple times.

CREATE TABLE IF NOT EXISTS public.user_capability_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  capability_id TEXT NOT NULL,
  preferred_connector_id TEXT NOT NULL,
  set_method TEXT NOT NULL DEFAULT 'explicit'
    CHECK (set_method IN ('explicit', 'learned', 'onboarding')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, capability_id)
);

CREATE INDEX IF NOT EXISTS idx_user_cap_pref_user
  ON public.user_capability_preferences (user_id, capability_id);

ALTER TABLE public.user_capability_preferences ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'user_capability_preferences'
       AND policyname = 'ucp_owner_access'
  ) THEN
    CREATE POLICY ucp_owner_access ON public.user_capability_preferences
      FOR ALL USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'user_capability_preferences'
       AND policyname = 'ucp_service_role'
  ) THEN
    CREATE POLICY ucp_service_role ON public.user_capability_preferences
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.capability_play_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  capability_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  reason TEXT,
  args JSONB DEFAULT '{}'::jsonb,
  ok BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cap_play_log_user_cap
  ON public.capability_play_log (user_id, capability_id, created_at DESC);

ALTER TABLE public.capability_play_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'capability_play_log'
       AND policyname = 'cpl_owner_read'
  ) THEN
    CREATE POLICY cpl_owner_read ON public.capability_play_log
      FOR SELECT USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'capability_play_log'
       AND policyname = 'cpl_service_role'
  ) THEN
    CREATE POLICY cpl_service_role ON public.capability_play_log
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
