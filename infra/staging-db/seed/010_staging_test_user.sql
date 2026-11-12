-- VTID-05782 (plan autonomous-to-staging-r2, design.md §3): the synthetic seed of the isolated staging database.
-- The documented test account a27552a3-0257-4305-8ed0-351a80fd3701 (CLAUDE.md "Test user UUID") gets a profile-free
-- auth.users row, one synthetic staging tenant and a community membership, so auth.uid() and RLS resolve for the
-- read-only STAGING-VERIFY sign-in. Everything else in this database is synthetic (supabase/tests/fixtures). No row
-- here is copied from production. Idempotent (fixed ids, ON CONFLICT / NOT EXISTS). Triggers are off for the load
-- (session_replication_role = replica), as in the fixtures: welcome-chat and notification fan-out never fire.
BEGIN;
SET LOCAL session_replication_role = replica;

INSERT INTO public.tenants (id, slug, name) VALUES
  ('5ea1a000-0000-4000-8000-000000000001', 'staging-synthetic', 'Staging Synthetic Tenant')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email) VALUES
  ('a27552a3-0257-4305-8ed0-351a80fd3701', 'e2e-test@vitana.dev')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
SELECT '5ea1a000-0000-4000-8000-000000000001'::uuid, 'a27552a3-0257-4305-8ed0-351a80fd3701'::uuid, 'community', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_tenants
   WHERE tenant_id = '5ea1a000-0000-4000-8000-000000000001'::uuid AND user_id = 'a27552a3-0257-4305-8ed0-351a80fd3701'::uuid
);

-- The test account is a registered test actor (CLAUDE.md NEVER 43-45), also in the isolated database.
DO $$
BEGIN
  IF to_regclass('public.notification_test_actors') IS NOT NULL THEN
    EXECUTE $q$INSERT INTO public.notification_test_actors (user_id) VALUES ('a27552a3-0257-4305-8ed0-351a80fd3701') ON CONFLICT DO NOTHING$q$;
  END IF;
  IF to_regclass('public.service_bot_accounts') IS NOT NULL THEN
    EXECUTE $q$INSERT INTO public.service_bot_accounts (user_id, label, reason) VALUES ('a27552a3-0257-4305-8ed0-351a80fd3701', 'e2e-test (staging synthetic)', 'VTID-05782: documented test account, isolated staging seed') ON CONFLICT DO NOTHING$q$;
  END IF;
END $$;

COMMIT;
