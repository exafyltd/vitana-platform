-- VTID-04988 fixture: feature_entitlements with the live columns (2026-10-08)
-- and the VTID-03107 rows for the features that allowed reward_credits, plus
-- two purchased-only features. Throwaway local Postgres only.
CREATE TABLE IF NOT EXISTS public.feature_entitlements (
  plan_key text NOT NULL, feature_key text NOT NULL, quota integer NOT NULL, window_seconds integer NOT NULL,
  unit text NOT NULL, behavior_on_exceed text NOT NULL, credit_cost_per_unit integer NOT NULL,
  allowed_burn_buckets text[] NOT NULL, window_5h_quota integer, weekly_quota integer,
  PRIMARY KEY (plan_key, feature_key)
);
GRANT ALL ON public.feature_entitlements TO service_role;
INSERT INTO public.feature_entitlements (plan_key, feature_key, quota, window_seconds, unit, behavior_on_exceed, credit_cost_per_unit, allowed_burn_buckets)
SELECT p, f, 5, 2592000, 'count', 'soft_counter', 10, ARRAY['purchased_credits','reward_credits']
FROM unnest(ARRAY['free','premium','premium_5x','premium_20x']) p,
     unnest(ARRAY['match_posts','match_reveals','lab_analyses','photo_uploads']) f;
INSERT INTO public.feature_entitlements (plan_key, feature_key, quota, window_seconds, unit, behavior_on_exceed, credit_cost_per_unit, allowed_burn_buckets)
SELECT p, f, 40, 2592000, 'minutes', 'hard_block', 1, ARRAY['purchased_credits']
FROM unnest(ARRAY['free','premium','premium_5x','premium_20x']) p,
     unnest(ARRAY['live_room_minutes','voice_live_minutes']) f;
INSERT INTO public.profiles (user_id) VALUES ('00000000-0000-0000-0000-0000000000f1') ON CONFLICT DO NOTHING;
