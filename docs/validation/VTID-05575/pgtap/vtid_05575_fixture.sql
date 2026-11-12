-- VTID-05575 fixture: stand-ins for the LIVE vitana-v1 tables the lane migrations touch, plus members and intents.
-- Local throwaway database only (PGlite / `supabase test db`); never a shared or live one. Loaded BEFORE the lane
-- migrations (and before the real VTID-05582 migration 20261102051000, which adds the network_visible column), so the
-- daily_matches rows exist when scope is added (the backfill must classify them) and carry the legacy health reason codes.
-- daily_matches: vitana-v1 20251111124306:2-13 (no tenant column, no unique key). global_community_profiles as in the 05582 fixture.
CREATE TABLE public.tenants (tenant_id uuid PRIMARY KEY, slug text, is_platform boolean NOT NULL DEFAULT false);
CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  active_role text NOT NULL DEFAULT 'community', is_primary boolean NOT NULL DEFAULT false, UNIQUE (tenant_id, user_id));
CREATE TABLE public.global_community_profiles (user_id uuid PRIMARY KEY, display_name text, is_visible boolean NOT NULL DEFAULT true);
CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY);
CREATE TABLE public.notification_test_actors (user_id uuid PRIMARY KEY);

CREATE TABLE public.daily_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  matched_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  match_score decimal(5,2) NOT NULL,
  match_reasons jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT now() + interval '24 hours',
  viewed_at timestamptz,
  action text CHECK (action IN ('pass', 'connect', 'super_connect')));
ALTER TABLE public.daily_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own daily matches" ON public.daily_matches FOR SELECT USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update their own match actions" ON public.daily_matches FOR UPDATE USING ((SELECT auth.uid()) = user_id);
-- Live grants (scripts/aws/aurora-cutover-restore-grants.sql:329,1719,3113).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_matches TO authenticated;
GRANT ALL ON public.daily_matches TO service_role;

-- Intent engine stand-ins (vitana-v1 20260501000100 / 20260501000200 and the helper functions). Scoring helpers return
-- constants: the lane changes WHO is in the pool, never how a candidate is scored.
CREATE TABLE public.user_intents (
  intent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requester_user_id uuid NOT NULL, requester_vitana_id text,
  tenant_id uuid, intent_kind text NOT NULL, title text, scope text, category text, kind_payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open', visibility text NOT NULL DEFAULT 'public',
  embedding text, embedding_v2 text, match_count int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.intent_compatibility (kind_a text NOT NULL, kind_b text NOT NULL, PRIMARY KEY (kind_a, kind_b));
CREATE TABLE public.intent_matches (
  match_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), intent_a_id uuid NOT NULL, intent_b_id uuid NOT NULL,
  vitana_id_a text, vitana_id_b text, kind_pairing text, score numeric, match_reasons jsonb, compass_aligned boolean, state text,
  external_target_kind text NOT NULL DEFAULT '', external_target_id text NOT NULL DEFAULT '',
  UNIQUE (intent_a_id, intent_b_id, external_target_kind, external_target_id));
CREATE FUNCTION public.intent_location_fit(a jsonb, b jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT 0.5::numeric $$;
CREATE FUNCTION public.intent_overlap_time(a jsonb, b jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT 0.5::numeric $$;
CREATE FUNCTION public.intent_overlap_budget(a jsonb, b jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT 0.5::numeric $$;
CREATE FUNCTION public.intent_overlap_dance(a jsonb, b jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT 0.5::numeric $$;
CREATE FUNCTION public.intent_overlap_mutual_aid(a jsonb, b jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT 0.5::numeric $$;
CREATE FUNCTION public.intent_mutual_aid_inverse(a jsonb, b jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
CREATE FUNCTION public.intent_skill_fit(a jsonb, b jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT 0.5::numeric $$;
CREATE FUNCTION public.intent_activity_fit_social(a text, b text, c numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT 0.5::numeric $$;
CREATE FUNCTION public.intent_activity_exact(a text, b text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$;
CREATE FUNCTION public.intent_match_tier(s numeric) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'good' $$;
INSERT INTO public.intent_compatibility VALUES ('activity_seek', 'activity_seek');

-- Tenants and members. 0001 U1 in TA (+ the PLATFORM tenant), 0002 U2 in TA, 0003 U3 in TB, 0004 U4 in TA+TB (primary TA),
-- 0005 service bot (TB), 0006 notification test actor (TB), 0007 U7 in the PLATFORM tenant only, 0008 U8 in TA.
INSERT INTO public.tenants (tenant_id, slug, is_platform) VALUES
  ('05575000-0000-4000-8000-0000000000a1', 'ta', false),
  ('05575000-0000-4000-8000-0000000000a2', 'tb', false),
  ('05575000-0000-4000-8000-0000000000a3', 'platform', true);
INSERT INTO auth.users (id, email)
  SELECT ('05575000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, 'u' || g || '@example.test' FROM generate_series(1, 8) g;
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES
  ('05575000-0000-4000-8000-0000000000a1', '05575000-0000-4000-8000-000000000001', true),
  ('05575000-0000-4000-8000-0000000000a3', '05575000-0000-4000-8000-000000000001', false),
  ('05575000-0000-4000-8000-0000000000a1', '05575000-0000-4000-8000-000000000002', true),
  ('05575000-0000-4000-8000-0000000000a2', '05575000-0000-4000-8000-000000000003', true),
  ('05575000-0000-4000-8000-0000000000a1', '05575000-0000-4000-8000-000000000004', true),
  ('05575000-0000-4000-8000-0000000000a2', '05575000-0000-4000-8000-000000000004', false),
  ('05575000-0000-4000-8000-0000000000a2', '05575000-0000-4000-8000-000000000005', true),
  ('05575000-0000-4000-8000-0000000000a2', '05575000-0000-4000-8000-000000000006', true),
  ('05575000-0000-4000-8000-0000000000a3', '05575000-0000-4000-8000-000000000007', true),
  ('05575000-0000-4000-8000-0000000000a1', '05575000-0000-4000-8000-000000000008', true);
INSERT INTO public.service_bot_accounts (user_id) VALUES ('05575000-0000-4000-8000-000000000005');
INSERT INTO public.notification_test_actors (user_id) VALUES ('05575000-0000-4000-8000-000000000006');
INSERT INTO public.global_community_profiles (user_id, display_name)
  SELECT ('05575000-0000-4000-8000-00000000' || lpad(g::text, 4, '0'))::uuid, 'User ' || g FROM generate_series(1, 8) g;

-- Legacy daily_matches rows, written by generate-daily-matches before this lane (reasons include health-derived codes).
INSERT INTO public.daily_matches (id, user_id, matched_user_id, match_score, match_reasons) VALUES
  ('05575000-0000-4000-8000-0000000000d1', '05575000-0000-4000-8000-000000000001', '05575000-0000-4000-8000-000000000002', 80,
   '[{"code":"shared_pillar","params":{"pillar":"sleep"}},{"code":"similar_index"},{"code":"mutual_connections","params":{"count":2}}]'),
  ('05575000-0000-4000-8000-0000000000d2', '05575000-0000-4000-8000-000000000001', '05575000-0000-4000-8000-000000000003', 70,
   '[{"code":"similar_index"}]'),
  ('05575000-0000-4000-8000-0000000000d3', '05575000-0000-4000-8000-000000000003', '05575000-0000-4000-8000-000000000004', 60,
   '[{"code":"active_member"}]'),
  ('05575000-0000-4000-8000-0000000000d4', '05575000-0000-4000-8000-000000000004', '05575000-0000-4000-8000-000000000002', 65,
   '["Same location: Berlin", "similar_index"]'),
  ('05575000-0000-4000-8000-0000000000d5', '05575000-0000-4000-8000-000000000001', '05575000-0000-4000-8000-000000000007', 50,
   '[{"code":"same_location","params":{"location":"Pillar Street"}}]');

-- Intents for the matcher tests. Visible-by-opt-in is set in the test, after the migrations.
INSERT INTO public.user_intents (intent_id, requester_user_id, requester_vitana_id, tenant_id, intent_kind, visibility) VALUES
  ('05575000-0000-4000-8000-0000000001a1', '05575000-0000-4000-8000-000000000001', 'v1', '05575000-0000-4000-8000-0000000000a1', 'activity_seek', 'public'),
  ('05575000-0000-4000-8000-0000000001a2', '05575000-0000-4000-8000-000000000002', 'v2', '05575000-0000-4000-8000-0000000000a1', 'activity_seek', 'public'),
  ('05575000-0000-4000-8000-0000000001a3', '05575000-0000-4000-8000-000000000003', 'v3', '05575000-0000-4000-8000-0000000000a2', 'activity_seek', 'public'),
  ('05575000-0000-4000-8000-0000000001a4', '05575000-0000-4000-8000-000000000004', 'v4', '05575000-0000-4000-8000-0000000000a2', 'activity_seek', 'public'),
  ('05575000-0000-4000-8000-0000000001a5', '05575000-0000-4000-8000-000000000005', 'v5', '05575000-0000-4000-8000-0000000000a2', 'activity_seek', 'public'),
  ('05575000-0000-4000-8000-0000000001a8', '05575000-0000-4000-8000-000000000008', 'v8', '05575000-0000-4000-8000-0000000000a1', 'activity_seek', 'tenant');
