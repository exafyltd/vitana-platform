-- VTID-05623 test fixture: PGlite stand-ins for the tables that fire_welcome_chat_on_membership()
-- reads and writes, plus the welcome trigger exactly as VTID-03089 defines it. Columns are the
-- subset the function uses. Synthetic data only: the test inserts made-up UUIDs.
-- Run with the test file: docs/validation/VTID-05507/pglite-harness/run.mjs (see VTID-05023 M4 report).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'test tenant'
);

CREATE TABLE IF NOT EXISTS public.app_users (
  user_id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  vitana_id TEXT,
  welcome_chat_sent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.user_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  active_role TEXT NOT NULL DEFAULT 'community',
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.chat_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.chat_group_members (
  group_id UUID NOT NULL REFERENCES public.chat_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'bot')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  sender_id UUID NOT NULL,
  receiver_id UUID NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  sender_vitana_id TEXT,
  receiver_vitana_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Allowlists: service_bot_accounts as VTID-03990 creates it. notification_test_actors has no CREATE TABLE in
-- this repo (it lives in the community-app repo), so this stand-in only models its user_id key.
CREATE TABLE IF NOT EXISTS public.service_bot_accounts (
  user_id UUID PRIMARY KEY,
  label TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.notification_test_actors (
  user_id UUID PRIMARY KEY
);

-- Welcome trigger, as VTID-03089 creates it (the function body comes from the migration under test).
CREATE OR REPLACE FUNCTION public.fire_welcome_chat_on_membership()
RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;

DROP TRIGGER IF EXISTS welcome_chat_on_primary_membership ON public.user_tenants;
CREATE TRIGGER welcome_chat_on_primary_membership
AFTER INSERT ON public.user_tenants
FOR EACH ROW
WHEN (NEW.is_primary = true)
EXECUTE FUNCTION public.fire_welcome_chat_on_membership();
