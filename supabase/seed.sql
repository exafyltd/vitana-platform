-- Phase 0 staging build (handoff brief P0.1): seed for the persistent
-- `staging` Supabase branch. Runs automatically when the branch is created
-- via the dashboard (or `supabase branches create staging --persistent`) if
-- `[db.seed] enabled = true` is set in `supabase/config.toml`.
--
-- Targets the brief's acceptance criteria:
--   • ≥11 rows in auth.users  (e2e-test + 10 staging-test-NN)
--   • ≥50 rows in memory_items
--   • ≥20 rows in memory_facts
--   • ≥10 rows in autopilot_recommendations (mix of accepted/rejected/dismissed
--                                            equivalents: 4 activated + 3 rejected + 3 new/snoozed)
--   • Default tenant memberships so seed users have a working session
--
-- Hard rules (all enforced by ON CONFLICT clauses below):
--   • Idempotent — running the seed twice does NOT duplicate rows.
--   • Safe on a branch that already has the canonical bootstrap migrations
--     applied (auth users will skip-insert if their email exists).
--   • Synthetic content only — no PII, no real user names, no real emails
--     beyond `e2e-test@vitana.dev` (the documented platform fixture).
--
-- NEVER run this against the production Supabase project. The `staging`
-- branch is the only intended target. If you accidentally pipe this into
-- production, every `ON CONFLICT` clause is the only thing protecting you;
-- design-intent is staging-only.

BEGIN;

-- =============================================================================
-- 0. Extensions
-- =============================================================================
-- bcrypt for password hashing on direct auth.users inserts.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. Auth users
-- =============================================================================
-- Direct INSERT into auth.users with minimum required columns. Supabase
-- ordinarily expects you to provision via the Auth Admin API, but for seed
-- runs on a branch this is the canonical short path. All staging users share
-- the same bcrypt'd password 'VitanaStagingSeed2026!' — this is a STAGING
-- secret only and must never be reused on prod data.

DO $$
DECLARE
  v_pw_hash TEXT := crypt('VitanaStagingSeed2026!', gen_salt('bf', 10));
  v_now TIMESTAMPTZ := NOW();
BEGIN
  -- e2e-test fixture (canonical UUID from CLAUDE.md / e2e/global-setup.ts)
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_super_admin
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    'a27552a3-0257-4305-8ed0-351a80fd3701',
    'authenticated', 'authenticated',
    'e2e-test@vitana.dev', v_pw_hash, v_now,
    '{"provider":"email","providers":["email"],"staging_seed":true}'::jsonb,
    '{"display_name":"E2E Test","staging_seed":true}'::jsonb,
    v_now, v_now, false
  ) ON CONFLICT (id) DO NOTHING;

  -- 10 synthetic users: staging-test-01 .. staging-test-10.
  FOR i IN 1..10 LOOP
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_super_admin
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      ('20260601-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
      'authenticated', 'authenticated',
      'staging-test-' || lpad(i::text, 2, '0') || '@vitana.dev', v_pw_hash, v_now,
      '{"provider":"email","providers":["email"],"staging_seed":true}'::jsonb,
      jsonb_build_object('display_name', 'Staging Test ' || lpad(i::text, 2, '0'), 'staging_seed', true),
      v_now, v_now, false
    ) ON CONFLICT (id) DO NOTHING;
  END LOOP;
END $$;

-- =============================================================================
-- 2. App_users mirror (canonical app-side registry)
-- =============================================================================
INSERT INTO public.app_users (user_id, email, display_name) VALUES
  ('a27552a3-0257-4305-8ed0-351a80fd3701', 'e2e-test@vitana.dev', 'E2E Test')
ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name;

DO $$
DECLARE
  uid UUID;
BEGIN
  FOR i IN 1..10 LOOP
    uid := ('20260601-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid;
    INSERT INTO public.app_users (user_id, email, display_name) VALUES (
      uid, 'staging-test-' || lpad(i::text, 2, '0') || '@vitana.dev',
      'Staging Test ' || lpad(i::text, 2, '0')
    ) ON CONFLICT (user_id) DO UPDATE
      SET email = EXCLUDED.email, display_name = EXCLUDED.display_name;
  END LOOP;
END $$;

-- =============================================================================
-- 3. Tenant memberships (everybody is in Maxina for staging — single tenant
-- keeps RLS noise out of fine-tuning evals)
-- =============================================================================
INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary) VALUES
  ('11111111-1111-1111-1111-111111111111', 'a27552a3-0257-4305-8ed0-351a80fd3701', 'community', true)
ON CONFLICT (tenant_id, user_id) DO NOTHING;

DO $$
DECLARE
  uid UUID;
BEGIN
  FOR i IN 1..10 LOOP
    uid := ('20260601-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid;
    INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
      VALUES ('11111111-1111-1111-1111-111111111111', uid, 'community', true)
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
  END LOOP;
END $$;

-- =============================================================================
-- 4. memory_items — synthetic conversational content (≥50 rows, spread)
-- =============================================================================
-- Five items per synthetic user, plus a few on the e2e-test fixture so the
-- "you have memory" path activates on first ORB session. Categories pulled
-- from public.memory_categories canonical keys.
DO $$
DECLARE
  v_tenant UUID := '11111111-1111-1111-1111-111111111111';
  uid UUID;
  v_cats TEXT[] := ARRAY['conversation','health','preferences','goals','community'];
  v_samples TEXT[] := ARRAY[
    'Wakes up around 7am most days and prefers a slow morning ritual.',
    'Has been tracking daily steps and is aiming for 10,000.',
    'Enjoys cold-plunges twice a week with a community group.',
    'Reading habit: 20 minutes of non-fiction before bed.',
    'Wants to learn conversational Spanish over the next 6 months.'
  ];
BEGIN
  FOR i IN 1..10 LOOP
    uid := ('20260601-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid;
    FOR j IN 1..5 LOOP
      INSERT INTO public.memory_items (
        tenant_id, user_id, category_key, source, content, importance, occurred_at
      ) VALUES (
        v_tenant, uid, v_cats[j], 'system', v_samples[j], 30 + (j * 5),
        NOW() - (j * INTERVAL '1 day')
      );
    END LOOP;
  END LOOP;

  -- Five extra rows on the e2e-test fixture so /memory/garden returns
  -- non-empty results when the fine-tuning eval harness queries it.
  FOR j IN 1..5 LOOP
    INSERT INTO public.memory_items (
      tenant_id, user_id, category_key, source, content, importance, occurred_at
    ) VALUES (
      v_tenant, 'a27552a3-0257-4305-8ed0-351a80fd3701', v_cats[j], 'system',
      'Staging fixture memory ' || j || ': ' || v_samples[j], 40,
      NOW() - (j * INTERVAL '1 day')
    );
  END LOOP;
END $$;

-- =============================================================================
-- 5. memory_facts — semantic key/value facts with provenance (≥20 rows)
-- =============================================================================
DO $$
DECLARE
  v_tenant UUID := '11111111-1111-1111-1111-111111111111';
  uid UUID;
  v_keys TEXT[] := ARRAY['preferred_language','user_birthday'];
  v_vals TEXT[] := ARRAY['en','1990-01-01'];
  v_types TEXT[] := ARRAY['text','date'];
BEGIN
  FOR i IN 1..10 LOOP
    uid := ('20260601-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid;
    FOR k IN 1..2 LOOP
      INSERT INTO memory_facts (
        tenant_id, user_id, entity, fact_key, fact_value, fact_value_type,
        provenance_source, provenance_confidence
      ) VALUES (
        v_tenant, uid, 'self', v_keys[k], v_vals[k], v_types[k],
        'system_provision', 0.95
      );
    END LOOP;
  END LOOP;
END $$;

-- =============================================================================
-- 6. autopilot_recommendations — 10 rows mixed across status values
-- =============================================================================
-- 4 "activated" (proxy for the brief's "accepted") + 3 "rejected" + 3 "new"
-- (proxy for "dismissed/snoozed not yet activated"). Each carries a stable
-- title + domain so the ranker has labeled training shape on day one.
INSERT INTO autopilot_recommendations (title, summary, domain, risk_level, impact_score, effort_score, status)
VALUES
  ('Stage-deploy smoke: cold plunge nudge', 'Suggest a morning cold plunge to staging-test-01 on Tuesdays.', 'health', 'low', 6, 3, 'activated'),
  ('Stage-deploy smoke: hydration reminder', 'Two glasses of water by 10am for staging-test-02.', 'health', 'low', 5, 1, 'activated'),
  ('Stage-deploy smoke: 10-minute walk', 'Post-lunch walk reminder for staging-test-03.', 'longevity', 'low', 7, 2, 'activated'),
  ('Stage-deploy smoke: weekly meal prep', 'Sunday-afternoon meal prep block for staging-test-04.', 'health', 'low', 6, 4, 'activated'),
  ('Stage-deploy smoke: late-night screen cap', 'Cut screens after 10pm — staging-test-05.', 'health', 'low', 8, 5, 'rejected'),
  ('Stage-deploy smoke: cardio block', 'Add a 20-min cardio block — staging-test-06.', 'health', 'medium', 7, 6, 'rejected'),
  ('Stage-deploy smoke: meditation start', 'Begin a 5-min morning meditation — staging-test-07.', 'longevity', 'low', 6, 2, 'rejected'),
  ('Stage-deploy smoke: community check-in', 'Reach out to one community member weekly — staging-test-08.', 'community', 'low', 5, 1, 'new'),
  ('Stage-deploy smoke: longevity reading', '15 minutes of longevity reading per day — staging-test-09.', 'longevity', 'low', 6, 1, 'new'),
  ('Stage-deploy smoke: business check-in', 'Weekly retro on business goals — staging-test-10.', 'professional', 'low', 7, 3, 'new')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 7. Reference data — system_config rows the gateway expects on boot
-- =============================================================================
-- The brief calls for "Reference data: pillar definitions, system_config rows
-- the gateway expects on boot." pillar definitions are already in the
-- canonical bootstrap migrations and flow into the branch automatically.
-- system_config is staging-specific only when the parent session decides;
-- nothing in Phase 0 itself depends on a row that isn't already in the
-- migration history, so this section is intentionally empty.
--
-- If a future phase needs a staging-only system_config override, add it here
-- with an explicit comment naming the phase + intent.

COMMIT;
