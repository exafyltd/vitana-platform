-- Vitana Intent Engine — P2-A · 1/9
-- VTID-01973
--
-- Taxonomy + compatibility matrix for the unified intent engine.
-- Replaces the original "reverse marketplace" twin schema with a single
-- discriminated table; this migration seeds the kind registry that all
-- downstream tables key off.
--
-- Kinds (extensible later via INSERT):
--   commercial_buy   — "I want to buy / I need a service"
--   commercial_sell  — "I'm selling / I provide this service"
--   activity_seek    — "I want a tennis partner / hiking buddy"
--   partner_seek     — "I'd like to find a life partner"  (mutual-reveal)
--   social_seek      — "Coffee chat / mentorship / networking"
--   mutual_aid       — "I can lend / borrow / give / receive"
--
-- The intent_compatibility table tells the matcher which kinds match
-- which (e.g. commercial_buy ↔ commercial_sell asymmetric;
-- activity_seek ↔ activity_seek symmetric; partner_seek requires
-- mutual reveal before counterparty vitana_id is exposed).

CREATE TABLE IF NOT EXISTS public.intent_kinds (
  kind_key                     text PRIMARY KEY,
  label                        text NOT NULL,
  supports_proactive_prompt    boolean NOT NULL DEFAULT true,
  default_visibility           text NOT NULL DEFAULT 'public'
                               CHECK (default_visibility IN ('public','tenant','private','mutual_reveal')),
  per_kind_notification_cap    int NOT NULL DEFAULT 3,
  sort_order                   int NOT NULL DEFAULT 0,
  active                       boolean NOT NULL DEFAULT true,
  created_at                   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.intent_kinds IS
  'Registry of all intent kinds the engine supports. New kinds (e.g. mentor_seek, co_founder_seek) are added by INSERT. Each kind has its own visibility default, notification cap, and proactive-prompt opt-in. See plan: i-want-a-solution-streamed-patterson.md';

INSERT INTO public.intent_kinds (kind_key, label, supports_proactive_prompt, default_visibility, per_kind_notification_cap, sort_order) VALUES
  ('commercial_buy',  'Looking to buy / hire',          true,  'public',         3, 10),
  ('commercial_sell', 'Selling / offering services',    true,  'public',         3, 20),
  ('activity_seek',   'Looking for an activity partner',true,  'tenant',         3, 30),
  ('partner_seek',    'Looking for a life partner',     false, 'mutual_reveal',  2, 40),
  ('social_seek',     'Coffee chat / mentorship',       true,  'tenant',         3, 50),
  ('mutual_aid',      'Lending / borrowing / gifting',  true,  'public',         3, 60)
ON CONFLICT (kind_key) DO NOTHING;

-- Compatibility matrix: which kind_a matches which kind_b.
-- is_symmetric = true means the same kind matches itself (activity ↔ activity).
-- requires_mutual_reveal = true means the matcher creates a row but the
-- counterparty vitana_id is hidden until both sides express interest.
CREATE TABLE IF NOT EXISTS public.intent_compatibility (
  kind_a                  text NOT NULL REFERENCES public.intent_kinds(kind_key) ON DELETE CASCADE,
  kind_b                  text NOT NULL REFERENCES public.intent_kinds(kind_key) ON DELETE CASCADE,
  is_symmetric            boolean NOT NULL DEFAULT false,
  requires_mutual_reveal  boolean NOT NULL DEFAULT false,
  notes                   text,
  PRIMARY KEY (kind_a, kind_b)
);

COMMENT ON TABLE public.intent_compatibility IS
  'Pairing matrix. compute_intent_matches() reads this to know which kinds to scan for a given intent.';

INSERT INTO public.intent_compatibility (kind_a, kind_b, is_symmetric, requires_mutual_reveal, notes) VALUES
  ('commercial_buy',  'commercial_sell', false, false, 'demand pulls supply; federated also against external products catalog'),
  ('commercial_sell', 'commercial_buy',  false, false, 'supply pushed against open demand'),
  ('activity_seek',   'activity_seek',   true,  false, 'symmetric: both want the same activity'),
  ('partner_seek',    'partner_seek',    true,  true,  'symmetric + mutual-reveal protocol'),
  ('social_seek',     'social_seek',     true,  false, 'symmetric: coffee chat / mentorship'),
  ('mutual_aid',      'mutual_aid',      true,  false, 'symmetric but inverse direction (lend ↔ borrow, give ↔ receive)')
ON CONFLICT (kind_a, kind_b) DO NOTHING;

-- Per-kind hierarchical category taxonomy. Same column shape across kinds
-- so the UI can use a single picker. parent_key references the same table
-- to express hierarchy (commercial_buy.home_services has children
-- home_services.refurbishment, home_services.electrician, etc.).
CREATE TABLE IF NOT EXISTS public.intent_categories (
  kind_key      text NOT NULL REFERENCES public.intent_kinds(kind_key) ON DELETE CASCADE,
  category_key  text NOT NULL,
  parent_key    text,
  label         text NOT NULL,
  sort_order    int NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  PRIMARY KEY (kind_key, category_key)
);

CREATE INDEX IF NOT EXISTS intent_categories_parent_idx
  ON public.intent_categories (kind_key, parent_key);

COMMENT ON TABLE public.intent_categories IS
  'Per-kind taxonomy. ~25 entries seeded for commercial_*; smaller seeds for activity/partner/social/mutual_aid. Admin can disable per tenant via active flag.';

-- Seed: commercial taxonomy (~25 entries, mirrored across buy + sell).
INSERT INTO public.intent_categories (kind_key, category_key, parent_key, label, sort_order) VALUES
  -- commercial_buy parents
  ('commercial_buy', 'home_services',                NULL,            'Home services',                100),
  ('commercial_buy', 'home_services.refurbishment',  'home_services', 'Refurbishment / renovation',   101),
  ('commercial_buy', 'home_services.electrician',    'home_services', 'Electrician',                  102),
  ('commercial_buy', 'home_services.plumbing',       'home_services', 'Plumbing',                     103),
  ('commercial_buy', 'home_services.cleaning',       'home_services', 'Cleaning',                     104),
  ('commercial_buy', 'pro_services',                 NULL,            'Professional services',        200),
  ('commercial_buy', 'pro_services.legal',           'pro_services',  'Legal',                        201),
  ('commercial_buy', 'pro_services.accounting',      'pro_services',  'Accounting / tax',             202),
  ('commercial_buy', 'pro_services.translation',     'pro_services',  'Translation',                  203),
  ('commercial_buy', 'wellness',                     NULL,            'Wellness',                     300),
  ('commercial_buy', 'wellness.coaching',            'wellness',      'Coaching',                     301),
  ('commercial_buy', 'wellness.nutrition',           'wellness',      'Nutrition',                    302),
  ('commercial_buy', 'travel',                       NULL,            'Travel',                       400),
  ('commercial_buy', 'travel.itinerary_planning',    'travel',        'Itinerary planning',           401),
  ('commercial_buy', 'travel.local_guide',           'travel',        'Local guide',                  402),
  ('commercial_buy', 'local',                        NULL,            'Local help',                   500),
  ('commercial_buy', 'local.errands',                'local',         'Errands',                      501),
  ('commercial_buy', 'local.delivery',               'local',         'Delivery',                     502),
  ('commercial_buy', 'local.handyman',               'local',         'Handyman',                     503),
  ('commercial_buy', 'digital',                      NULL,            'Digital',                      600),
  ('commercial_buy', 'digital.web_dev',              'digital',       'Web development',              601),
  ('commercial_buy', 'digital.design',               'digital',       'Design',                       602),
  ('commercial_buy', 'digital.marketing',            'digital',       'Marketing',                    603),
  ('commercial_buy', 'education',                    NULL,            'Education',                    700),
  ('commercial_buy', 'education.tutoring',           'education',     'Tutoring',                     701),
  ('commercial_buy', 'education.language',           'education',     'Language teaching',            702),
  ('commercial_buy', 'events',                       NULL,            'Events',                       800),
  ('commercial_buy', 'events.catering',              'events',        'Catering',                     801),
  ('commercial_buy', 'events.photography',           'events',        'Photography',                  802),
  ('commercial_buy', 'events.music',                 'events',        'Music / DJ',                   803)
ON CONFLICT (kind_key, category_key) DO NOTHING;

-- Mirror the commercial_buy taxonomy onto commercial_sell so providers and
-- demanders share the same vocabulary.
INSERT INTO public.intent_categories (kind_key, category_key, parent_key, label, sort_order)
SELECT 'commercial_sell', category_key, parent_key, label, sort_order
  FROM public.intent_categories
 WHERE kind_key = 'commercial_buy'
ON CONFLICT (kind_key, category_key) DO NOTHING;

-- Seed: activity_seek (sport + creative + learning).
INSERT INTO public.intent_categories (kind_key, category_key, parent_key, label, sort_order) VALUES
  ('activity_seek', 'sport',                NULL,        'Sport',                  100),
  ('activity_seek', 'sport.tennis',         'sport',     'Tennis',                 101),
  ('activity_seek', 'sport.running',        'sport',     'Running',                102),
  ('activity_seek', 'sport.hiking',         'sport',     'Hiking',                 103),
  ('activity_seek', 'sport.cycling',        'sport',     'Cycling',                104),
  ('activity_seek', 'sport.yoga',           'sport',     'Yoga',                   105),
  ('activity_seek', 'sport.gym',            'sport',     'Gym buddy',              106),
  ('activity_seek', 'creative',             NULL,        'Creative',               200),
  ('activity_seek', 'creative.music',       'creative',  'Music / jam',            201),
  ('activity_seek', 'creative.painting',    'creative',  'Painting / drawing',     202),
  ('activity_seek', 'learning',             NULL,        'Learning',               300),
  ('activity_seek', 'learning.language',    'learning',  'Language exchange',      301),
  ('activity_seek', 'learning.book_club',   'learning',  'Book club',              302)
ON CONFLICT (kind_key, category_key) DO NOTHING;

-- Seed: partner_seek (relationship facets).
INSERT INTO public.intent_categories (kind_key, category_key, parent_key, label, sort_order) VALUES
  ('partner_seek', 'life_partner',  NULL, 'Life partner',     100),
  ('partner_seek', 'dating',        NULL, 'Dating',           110),
  ('partner_seek', 'companionship', NULL, 'Companionship',    120)
ON CONFLICT (kind_key, category_key) DO NOTHING;

-- Seed: social_seek.
INSERT INTO public.intent_categories (kind_key, category_key, parent_key, label, sort_order) VALUES
  ('social_seek', 'mentorship',   NULL, 'Mentorship',         100),
  ('social_seek', 'networking',   NULL, 'Networking',         110),
  ('social_seek', 'coffee_chat',  NULL, 'Coffee chat',        120),
  ('social_seek', 'peer_support', NULL, 'Peer support',       130)
ON CONFLICT (kind_key, category_key) DO NOTHING;

-- Seed: mutual_aid (direction + object). Direction handled in kind_payload.
INSERT INTO public.intent_categories (kind_key, category_key, parent_key, label, sort_order) VALUES
  ('mutual_aid', 'lend',     NULL, 'Lending',          100),
  ('mutual_aid', 'borrow',   NULL, 'Borrowing',        110),
  ('mutual_aid', 'gift',     NULL, 'Gifting',          120),
  ('mutual_aid', 'receive',  NULL, 'Receiving',        130),
  ('mutual_aid', 'help_me',  NULL, 'Asking for help',  140)
ON CONFLICT (kind_key, category_key) DO NOTHING;
