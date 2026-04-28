-- D6 tier-required registry (VTID-DANCE-D6)
-- Per (intent_kind, category, condition) → minimum trust_tier required.
-- The intents POST route reads this to gate posts. Operator role bypasses.
--
-- condition is a SQL-evaluable predicate over kind_payload, JSONB-friendly:
--   { "price_cents": { ">": 5000 } }   -- price > 50 EUR
--   { "any": true }                    -- always (no extra condition)

CREATE TABLE IF NOT EXISTS public.intent_tier_required (
  rule_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_kind      text NOT NULL,
  category_prefix  text,                                          -- NULL = any category
  payload_match    jsonb NOT NULL DEFAULT '{}'::jsonb,            -- { "price_cents_gt": 5000 } etc.
  required_tier    text NOT NULL CHECK (required_tier IN ('community_verified','pro_verified','id_verified')),
  reason           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS intent_tier_required_kind_idx
  ON public.intent_tier_required (intent_kind, category_prefix);

COMMENT ON TABLE public.intent_tier_required IS
  'D6: per-kind/category trust-tier minimums. Read by gateway intents route to gate posts. Operator role bypasses.';

-- Seed dance-relevant rules.
INSERT INTO public.intent_tier_required (intent_kind, category_prefix, payload_match, required_tier, reason) VALUES
  ('mentor_seek',     'dance.teaching.', '{"any": true}'::jsonb,                        'community_verified', 'Teaching others requires community vouching'),
  ('mentor_seek',     'dance.teaching.', '{"price_cents_gt": 5000}'::jsonb,              'pro_verified',       'Charging >€50/lesson requires pro verification'),
  ('commercial_sell', 'dance.lesson_paid','{"any": true}'::jsonb,                        'community_verified', 'Selling paid lessons requires community vouching'),
  ('commercial_sell', 'dance.lesson_paid','{"price_cents_gt": 5000}'::jsonb,             'pro_verified',       'Charging >€50/lesson requires pro verification'),
  ('commercial_sell', 'dance.class_paid', '{"any": true}'::jsonb,                        'community_verified', 'Selling paid classes requires community vouching'),
  ('commercial_sell', 'dance.class_paid', '{"price_cents_gt": 5000}'::jsonb,             'pro_verified',       'Charging >€50/class requires pro verification')
ON CONFLICT DO NOTHING;
