-- Vitana Intent Engine — P2-A · 7/9
-- VTID-01973
--
-- Joins user_intents with the existing life_compass table (G3 of
-- vitana_autopilot_index_compass_loop) so the matcher and notifier can
-- read each user's active Life Compass goal at a glance.
--
-- The matcher reads this view to decide whether a (vitana_id_a,
-- vitana_id_b) pair is "compass aligned" — i.e. whether their respective
-- active goals fall in the boost matrix for the kind_pairing. The notifier
-- uses the alignment flag to prioritise surfacing.
--
-- Compass-to-kind boost matrix (P2-A baseline, can be extended):
--   active_compass_category  →  boosted intent_kinds
--   ─────────────────────────────────────────────────
--   earn_money / business    →  commercial_buy, commercial_sell, social_seek (mentorship)
--   longevity / health       →  activity_seek, social_seek, commercial_buy (wellness only)
--   life_partner             →  partner_seek, activity_seek, social_seek
--   family / community       →  mutual_aid, social_seek, activity_seek (group)
--   career_growth            →  social_seek (mentorship), commercial_sell, commercial_buy (skills)
--   general                  →  no boost (neutral)
--
-- The boost is encoded in a small lookup table seeded here.

CREATE TABLE IF NOT EXISTS public.intent_compass_boost (
  compass_category   text NOT NULL,
  intent_kind        text NOT NULL REFERENCES public.intent_kinds(kind_key) ON DELETE CASCADE,
  boost_weight       numeric(3,2) NOT NULL DEFAULT 0.10
                     CHECK (boost_weight >= 0 AND boost_weight <= 0.30),
  PRIMARY KEY (compass_category, intent_kind)
);

COMMENT ON TABLE public.intent_compass_boost IS
  'Maps Life Compass goal categories to intent kinds that should get a score bump when both parties are aligned. Read by intent-compass-lens.ts and the notifier.';

INSERT INTO public.intent_compass_boost (compass_category, intent_kind, boost_weight) VALUES
  ('earn_money',    'commercial_buy',  0.10),
  ('earn_money',    'commercial_sell', 0.10),
  ('earn_money',    'social_seek',     0.05),
  ('business',      'commercial_buy',  0.10),
  ('business',      'commercial_sell', 0.10),
  ('business',      'social_seek',     0.10),
  ('longevity',     'activity_seek',   0.10),
  ('longevity',     'social_seek',     0.05),
  ('longevity',     'commercial_buy',  0.05),
  ('health',        'activity_seek',   0.10),
  ('health',        'social_seek',     0.05),
  ('life_partner',  'partner_seek',    0.10),
  ('life_partner',  'activity_seek',   0.05),
  ('life_partner',  'social_seek',     0.05),
  ('family',        'mutual_aid',      0.10),
  ('family',        'social_seek',     0.05),
  ('family',        'activity_seek',   0.05),
  ('community',     'mutual_aid',      0.10),
  ('community',     'social_seek',     0.10),
  ('career_growth', 'social_seek',     0.10),
  ('career_growth', 'commercial_sell', 0.10),
  ('career_growth', 'commercial_buy',  0.05)
ON CONFLICT (compass_category, intent_kind) DO NOTHING;

-- View: per intent, what is the user's active Life Compass goal?
-- (life_compass.is_active=true → the user's current focus.)
CREATE OR REPLACE VIEW public.intent_compass_alignment AS
SELECT
  ui.intent_id,
  ui.requester_user_id,
  ui.requester_vitana_id,
  ui.intent_kind,
  lc.category                                            AS active_compass_category,
  lc.primary_goal                                        AS active_compass_goal,
  COALESCE(icb.boost_weight, 0)                          AS compass_boost_weight,
  (icb.boost_weight IS NOT NULL)                         AS is_compass_aligned
FROM public.user_intents ui
LEFT JOIN public.life_compass lc
       ON lc.user_id = ui.requester_user_id
      AND lc.is_active = true
LEFT JOIN public.intent_compass_boost icb
       ON icb.compass_category = lc.category
      AND icb.intent_kind = ui.intent_kind;

COMMENT ON VIEW public.intent_compass_alignment IS
  'Per-intent Life Compass alignment lookup. Read by intent-compass-lens.ts to decide whether a match is compass-aligned (which adds a score bonus and bumps notification priority).';
