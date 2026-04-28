-- D7 auto-templated demands (VTID-DANCE-D7)
-- Per (intent_kind, category) → template scope text the IntentComposer can
-- prefill. Reduces friction for cold-start users who haven't dictated yet
-- — they pick a category and get a fluent default scope they can tweak.

CREATE TABLE IF NOT EXISTS public.intent_scope_templates (
  template_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_kind    text NOT NULL,
  category_key   text,                                       -- NULL = matches any category in the kind
  template_title text NOT NULL,
  template_scope text NOT NULL,
  payload_hint   jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order     int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS intent_scope_templates_lookup_idx
  ON public.intent_scope_templates (intent_kind, category_key);

COMMENT ON TABLE public.intent_scope_templates IS
  'D7: prefill scaffolds for intent posts. The IntentComposer fetches a template by (kind, category) and pre-populates title + scope so the user can edit instead of starting from blank.';

INSERT INTO public.intent_scope_templates (intent_kind, category_key, template_title, template_scope, payload_hint, sort_order) VALUES
  -- Dance learning
  ('learning_seek', 'dance.learning.salsa',
    'Want to learn salsa',
    'Looking for a salsa teacher near my city. Beginner level, prefer in-person but open to online for theory. Weekday evenings work best for me — happy to share more once we connect.',
    '{"learning":{"topic":"salsa","mode_pref":"in_person"},"dance":{"variety":"salsa","level_target":"beginner"}}'::jsonb,
    10),
  ('learning_seek', 'dance.learning.tango',
    'Want to learn tango',
    'Looking for a tango teacher. Beginner level, in-person preferred — weekday evenings or weekend. Tell me about your style and pricing.',
    '{"learning":{"topic":"tango","mode_pref":"in_person"},"dance":{"variety":"tango","level_target":"beginner"}}'::jsonb,
    11),
  ('learning_seek', 'dance.learning.bachata',
    'Want to learn bachata',
    'Looking for a bachata teacher. Beginner-friendly please. Open to in-person or online. Weekday evenings work best.',
    '{"learning":{"topic":"bachata","mode_pref":"either"},"dance":{"variety":"bachata","level_target":"beginner"}}'::jsonb,
    12),
  -- Dance teaching
  ('mentor_seek', 'dance.teaching.salsa',
    'Offering salsa lessons',
    'I teach salsa. In-person and online slots available. Beginner-friendly with structured progression. Reach out for pricing and schedule.',
    '{"teaching":{"topic":"salsa","modes_offered":["in_person","online"]},"dance":{"variety":"salsa"}}'::jsonb,
    20),
  ('mentor_seek', 'dance.teaching.tango',
    'Offering tango lessons',
    'I teach tango. Private and small-group lessons available. Both lead and follow welcome. Message me for schedule.',
    '{"teaching":{"topic":"tango","modes_offered":["in_person"]},"dance":{"variety":"tango"}}'::jsonb,
    21),
  -- Activity dance
  ('activity_seek', 'dance.social_partner',
    'Looking for a dance partner',
    'Looking for someone to social-dance with. Open to weekly or occasional sessions. Tell me your style, level, and availability.',
    '{"dance":{"role_pref":"either","formality":"social"}}'::jsonb,
    30),
  ('activity_seek', 'dance.group_outing',
    'Going out dancing this weekend',
    'Heading out dancing — looking for a small group to join. Drop a message if you''re up for it; tell me your usual spots.',
    '{"dance":{"formality":"casual"}}'::jsonb,
    31),
  ('activity_seek', 'dance.practice',
    'Practice partner / training',
    'Looking for a practice partner — twice a week, structured sessions. Beginner welcome; we''ll match level and styles.',
    '{"dance":{"role_pref":"either","formality":"social"}}'::jsonb,
    32),
  -- Other kinds: small set
  ('commercial_buy', NULL,
    'Looking to hire',
    'Looking for someone to help me with a project. Tell me about your experience, availability, and pricing.',
    '{}'::jsonb,
    100),
  ('commercial_sell', NULL,
    'Offering services',
    'I offer services in this area. Reach out for pricing, availability, and portfolio links.',
    '{}'::jsonb,
    101),
  ('social_seek', NULL,
    'Coffee chat / networking',
    'Open to a coffee chat with someone in this space. 30 minutes, no agenda — just a good conversation.',
    '{"format_pref":"either"}'::jsonb,
    102),
  ('mutual_aid', NULL,
    'Open to lending / borrowing',
    'Happy to share what I have / borrow what I need within the community. Tell me what you''re thinking.',
    '{}'::jsonb,
    103)
ON CONFLICT DO NOTHING;
