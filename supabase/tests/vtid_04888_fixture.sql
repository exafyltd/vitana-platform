-- VTID-04888 harness fixture: the slice of the production schema the rule-45 migration and fix-up touch.
-- Local throwaway Postgres only (scripts/ci/test-vtid-04888-rule45.sh). pgvector is not installed there, so
-- the runner rewrites vector(N) to text and this fixture gives text a stub <=> operator; the vector maths is
-- not under test, the exclusion predicates are.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE FUNCTION public.text_dist(a text, b text) RETURNS float8 LANGUAGE sql IMMUTABLE AS 'SELECT 0.5::float8';
CREATE OPERATOR public.<=> (LEFTARG = text, RIGHTARG = text, FUNCTION = public.text_dist);

-- Scoring helpers: constant stubs (signatures as called by the intent RPCs).
CREATE FUNCTION public.intent_location_fit(a jsonb, b jsonb) RETURNS numeric LANGUAGE sql AS 'SELECT 0.5';
CREATE FUNCTION public.intent_overlap_time(a jsonb, b jsonb) RETURNS numeric LANGUAGE sql AS 'SELECT 0.5';
CREATE FUNCTION public.intent_overlap_budget(a jsonb, b jsonb) RETURNS numeric LANGUAGE sql AS 'SELECT 0.5';
CREATE FUNCTION public.intent_overlap_dance(a jsonb, b jsonb) RETURNS numeric LANGUAGE sql AS 'SELECT 0.5';
CREATE FUNCTION public.intent_overlap_mutual_aid(a jsonb, b jsonb) RETURNS numeric LANGUAGE sql AS 'SELECT 0.5';
CREATE FUNCTION public.intent_activity_fit_social(a text, b text, e numeric) RETURNS numeric LANGUAGE sql AS 'SELECT 0.5';
CREATE FUNCTION public.intent_skill_fit(a jsonb, b jsonb) RETURNS numeric LANGUAGE sql AS 'SELECT 0.5';
CREATE FUNCTION public.intent_activity_exact(a text, b text) RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION public.intent_mutual_aid_inverse(a jsonb, b jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION public.intent_match_tier(s numeric) RETURNS text LANGUAGE sql AS 'SELECT ''good''';

CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY);
CREATE TABLE public.notification_test_actors (user_id uuid PRIMARY KEY);
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, vitana_id text);
CREATE TABLE public.global_community_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  is_visible boolean NOT NULL DEFAULT true
);
GRANT SELECT, UPDATE ON public.global_community_profiles TO authenticated;

CREATE TABLE public.user_intents (
  intent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id uuid NOT NULL,
  requester_vitana_id text,
  tenant_id uuid,
  intent_kind text NOT NULL,
  category text,
  kind_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('draft','open','matched','engaged','fulfilled','closed','cancelled')),
  visibility text NOT NULL DEFAULT 'public',
  title text,
  scope text,
  embedding text,
  embedding_v2 text,
  match_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.intent_compatibility (kind_a text, kind_b text);
CREATE TABLE public.intent_matches (
  match_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_a_id uuid REFERENCES public.user_intents(intent_id),
  intent_b_id uuid REFERENCES public.user_intents(intent_id),
  vitana_id_a text,
  vitana_id_b text,
  external_target_kind text,
  external_target_id uuid,
  kind_pairing text,
  score numeric,
  match_reasons jsonb,
  compass_aligned boolean,
  state text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_a_id, intent_b_id, external_target_kind, external_target_id)
);
CREATE TABLE public.intent_match_recommendations (
  intent_id uuid PRIMARY KEY,
  candidates jsonb,
  voice_readback text,
  reasoning_summary text,
  updated_at timestamptz
);
CREATE TABLE public.intent_events (id serial PRIMARY KEY, match_id uuid REFERENCES public.intent_matches(match_id) ON DELETE CASCADE);
CREATE TABLE public.intent_disputes (id serial PRIMARY KEY, match_id uuid REFERENCES public.intent_matches(match_id) ON DELETE CASCADE);
CREATE TABLE public.user_ratings (id serial PRIMARY KEY, match_id uuid REFERENCES public.intent_matches(match_id) ON DELETE SET NULL);
CREATE TABLE public.service_payments (id serial PRIMARY KEY, match_id uuid REFERENCES public.intent_matches(match_id) ON DELETE SET NULL);
CREATE TABLE public.match_notifications (id serial PRIMARY KEY, match_id uuid);
CREATE TABLE public.autopilot_prompts (id serial PRIMARY KEY, match_id uuid);

-- Seed (fixed ids). R1, R2, R3 real members; X a test actor; B a service bot.
INSERT INTO public.notification_test_actors VALUES ('00000000-0000-0000-0000-0000000000a1');
INSERT INTO public.service_bot_accounts VALUES ('00000000-0000-0000-0000-0000000000b1');
INSERT INTO public.profiles VALUES
  ('00000000-0000-0000-0000-000000000001', 'V-R1'),
  ('00000000-0000-0000-0000-000000000002', 'V-R2'),
  ('00000000-0000-0000-0000-000000000003', 'V-R3'),
  ('00000000-0000-0000-0000-0000000000a1', 'V-X'),
  ('00000000-0000-0000-0000-0000000000b1', 'V-B');
INSERT INTO public.global_community_profiles (user_id) SELECT user_id FROM public.profiles;
INSERT INTO public.intent_compatibility VALUES ('activity_seek', 'activity_seek');
INSERT INTO public.user_intents (intent_id, requester_user_id, requester_vitana_id, intent_kind, category, status) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'V-R1', 'activity_seek', 'dance.salsa', 'open'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'V-R2', 'activity_seek', 'dance.salsa', 'open'),
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'V-X', 'activity_seek', 'dance.salsa', 'open'),
  ('10000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', 'V-B', 'activity_seek', 'dance.salsa', 'open');
-- Pre-existing matches (as production has them before the fix): R1-X, R1-R2, X-B.
INSERT INTO public.intent_matches (match_id, intent_a_id, intent_b_id, vitana_id_a, vitana_id_b, state) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000a1', 'V-R1', 'V-X', 'new'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'V-R1', 'V-R2', 'new'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000b1', 'V-X', 'V-B', 'new');
INSERT INTO public.intent_match_recommendations VALUES
  ('10000000-0000-0000-0000-0000000000a1', '[]'::jsonb, 'x readback', 'x summary', now()),
  ('10000000-0000-0000-0000-000000000001',
   '[{"intent_id":"10000000-0000-0000-0000-0000000000a1","vitana_id":"V-X"},{"intent_id":"10000000-0000-0000-0000-000000000002","vitana_id":"V-R2"}]'::jsonb,
   'r1 readback', 'r1 summary', now()),
  ('10000000-0000-0000-0000-000000000002',
   '[{"intent_id":"10000000-0000-0000-0000-000000000001","vitana_id":"V-R1"}]'::jsonb,
   'r2 readback', 'r2 summary', now());
-- Something real hanging off the real match only.
INSERT INTO public.intent_events (match_id) VALUES ('20000000-0000-0000-0000-000000000002');
