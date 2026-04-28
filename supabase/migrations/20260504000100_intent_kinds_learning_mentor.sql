-- Dance specialized market — Phase D1.2 (VTID-DANCE-D1)
-- Wire the two reserved-but-unwired intent kinds (learning_seek, mentor_seek)
-- and seed dance categories across the relevant kinds.

-- 1. Register the new kinds.
INSERT INTO public.intent_kinds (kind_key, label, supports_proactive_prompt, default_visibility, per_kind_notification_cap, sort_order) VALUES
  ('learning_seek', 'Looking to learn',  true, 'public', 3, 70),
  ('mentor_seek',   'Offering to teach', true, 'public', 3, 75)
ON CONFLICT (kind_key) DO NOTHING;

-- 2. Compatibility matrix — student/teacher pairings + commercial bridges.
INSERT INTO public.intent_compatibility (kind_a, kind_b, is_symmetric, requires_mutual_reveal, comment) VALUES
  ('learning_seek', 'mentor_seek',     false, false, 'asymmetric: student → teacher'),
  ('mentor_seek',   'learning_seek',   false, false, 'asymmetric: teacher → student'),
  ('learning_seek', 'commercial_sell', false, false, 'student → paid lesson seller'),
  ('mentor_seek',   'commercial_buy',  false, false, 'teacher → paying buyer')
ON CONFLICT DO NOTHING;

-- 3. Dance category tree, attached to all 5 dance-relevant kinds.
INSERT INTO public.intent_categories (kind_key, category_key, parent_key, label, sort_order) VALUES
  -- partner / social (under activity_seek)
  ('activity_seek', 'dance.social_partner', NULL, 'Find a dance partner', 100),
  ('activity_seek', 'dance.group_outing',   NULL, 'Go out dancing as a group', 101),
  ('activity_seek', 'dance.practice',       NULL, 'Practice / training partner', 102),
  ('activity_seek', 'dance.flash_mob',      NULL, 'Flash mob / event crew', 103),

  -- learning (under learning_seek)
  ('learning_seek', 'dance.learning.salsa',        NULL, 'Learn salsa', 110),
  ('learning_seek', 'dance.learning.tango',        NULL, 'Learn tango', 111),
  ('learning_seek', 'dance.learning.bachata',      NULL, 'Learn bachata', 112),
  ('learning_seek', 'dance.learning.kizomba',      NULL, 'Learn kizomba', 113),
  ('learning_seek', 'dance.learning.swing',        NULL, 'Learn swing', 114),
  ('learning_seek', 'dance.learning.ballroom',     NULL, 'Learn ballroom', 115),
  ('learning_seek', 'dance.learning.hiphop',       NULL, 'Learn hip-hop', 116),
  ('learning_seek', 'dance.learning.contemporary', NULL, 'Learn contemporary', 117),
  ('learning_seek', 'dance.learning.other',        NULL, 'Learn another style', 118),

  -- teaching (under mentor_seek)
  ('mentor_seek',     'dance.teaching.salsa',        NULL, 'Teach salsa', 120),
  ('mentor_seek',     'dance.teaching.tango',        NULL, 'Teach tango', 121),
  ('mentor_seek',     'dance.teaching.bachata',      NULL, 'Teach bachata', 122),
  ('mentor_seek',     'dance.teaching.kizomba',      NULL, 'Teach kizomba', 123),
  ('mentor_seek',     'dance.teaching.swing',        NULL, 'Teach swing', 124),
  ('mentor_seek',     'dance.teaching.ballroom',     NULL, 'Teach ballroom', 125),
  ('mentor_seek',     'dance.teaching.hiphop',       NULL, 'Teach hip-hop', 126),
  ('mentor_seek',     'dance.teaching.contemporary', NULL, 'Teach contemporary', 127),
  ('mentor_seek',     'dance.teaching.other',        NULL, 'Teach another style', 128),

  -- commercial dance (paid sales of services)
  ('commercial_sell', 'dance.lesson_paid', NULL, 'Paid dance lesson', 130),
  ('commercial_sell', 'dance.class_paid',  NULL, 'Paid dance class / workshop', 131),
  ('commercial_buy',  'dance.lesson_paid', NULL, 'Looking to pay for a dance lesson', 132),
  ('commercial_buy',  'dance.class_paid',  NULL, 'Looking to pay for a dance class', 133)
ON CONFLICT (kind_key, category_key) DO NOTHING;
