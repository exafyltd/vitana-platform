-- Phase D39 PR 5b (decision-contract refactor) — seed
-- `decision_compatibility_score` with the current D39 matrices.
--
-- VTID-03169. Second slice of the D39 taste-alignment externalization.
-- Inserts the full set of 138 cells across 9 dimensions, byte-identical
-- to the literals in
-- services/gateway/src/services/d39-taste-alignment-service.ts (rev
-- e962dbe7 at the time of writing). No code consumer reads from this
-- table yet — the resolver lands in PR 5c, the wiring in PR 5d-g.
--
-- Full-grid seeding strategy (matches PR 5a brief):
--   - simplicity / premium / routine / social / convenience /
--     experience / novelty: 1:1 with the inline scoreMap literals.
--   - aesthetic + tone: full 6×6 grids. The current service emits
--     0.3 for "not in compatibility list" and 0.5 for any row/col
--     touching 'neutral'. We seed all of those cells explicitly so
--     the PR 5c resolver does pure lookups and no implicit default
--     branch remains.
--
-- Idempotency:
--   ON CONFLICT DO NOTHING relies on the
--   UNIQUE NULLS NOT DISTINCT (dimension, profile_value,
--   candidate_value, tenant_id, version) constraint from PR 5a.
--   The migration is safe to re-run; existing global rows are
--   preserved untouched.
--
-- Rationale column:
--   Each row carries a short note keyed to its score band so an
--   analyst can scan the seed and audit intent without re-reading
--   the service file.
--
-- Cell counts per dimension (assertion target for the test):
--   simplicity:    9
--   premium:      12
--   aesthetic:    36
--   tone:         36
--   routine:       6
--   social:       12
--   convenience:   9
--   experience:    9
--   novelty:       9
--   ---------------
--   total:       138

-- =========================================================================
-- D39 simplicity matrix — 3×3 = 9 cells
-- d39-taste-alignment-service.ts scoreSimplicityAlignment
-- =========================================================================
INSERT INTO decision_compatibility_score
  (dimension, profile_value, candidate_value, score, rationale, tenant_id, version, source)
VALUES
  ('simplicity', 'minimalist',    'simple',   1.00, 'perfect match',        NULL, 1, 'seed'),
  ('simplicity', 'minimalist',    'moderate', 0.60, 'partial fit',          NULL, 1, 'seed'),
  ('simplicity', 'minimalist',    'complex',  0.20, 'strong mismatch',      NULL, 1, 'seed'),
  ('simplicity', 'balanced',      'simple',   0.70, 'compatible',           NULL, 1, 'seed'),
  ('simplicity', 'balanced',      'moderate', 1.00, 'perfect match',        NULL, 1, 'seed'),
  ('simplicity', 'balanced',      'complex',  0.70, 'compatible',           NULL, 1, 'seed'),
  ('simplicity', 'comprehensive', 'simple',   0.40, 'partial mismatch',     NULL, 1, 'seed'),
  ('simplicity', 'comprehensive', 'moderate', 0.70, 'compatible',           NULL, 1, 'seed'),
  ('simplicity', 'comprehensive', 'complex',  1.00, 'perfect match',        NULL, 1, 'seed')
ON CONFLICT DO NOTHING;

-- =========================================================================
-- D39 premium matrix — 3×4 = 12 cells
-- d39-taste-alignment-service.ts scorePremiumAlignment
-- =========================================================================
INSERT INTO decision_compatibility_score
  (dimension, profile_value, candidate_value, score, rationale, tenant_id, version, source)
VALUES
  ('premium', 'value_focused',     'budget',  1.00, 'perfect match',     NULL, 1, 'seed'),
  ('premium', 'value_focused',     'mid',     0.80, 'compatible',        NULL, 1, 'seed'),
  ('premium', 'value_focused',     'premium', 0.40, 'partial mismatch',  NULL, 1, 'seed'),
  ('premium', 'value_focused',     'luxury',  0.20, 'strong mismatch',   NULL, 1, 'seed'),
  ('premium', 'quality_balanced',  'budget',  0.60, 'partial fit',       NULL, 1, 'seed'),
  ('premium', 'quality_balanced',  'mid',     1.00, 'perfect match',     NULL, 1, 'seed'),
  ('premium', 'quality_balanced',  'premium', 0.80, 'compatible',        NULL, 1, 'seed'),
  ('premium', 'quality_balanced',  'luxury',  0.50, 'neutral',           NULL, 1, 'seed'),
  ('premium', 'premium_oriented',  'budget',  0.20, 'strong mismatch',   NULL, 1, 'seed'),
  ('premium', 'premium_oriented',  'mid',     0.50, 'neutral',           NULL, 1, 'seed'),
  ('premium', 'premium_oriented',  'premium', 1.00, 'perfect match',     NULL, 1, 'seed'),
  ('premium', 'premium_oriented',  'luxury',  0.90, 'compatible',        NULL, 1, 'seed')
ON CONFLICT DO NOTHING;

-- =========================================================================
-- D39 aesthetic matrix — full 6×6 = 36 cells
-- d39-taste-alignment-service.ts scoreAestheticAlignment
-- Diagonals = 1.0 (perfect match); compatibilityMap = 0.7; anything
-- with 'neutral' on either side = 0.5; remaining cells = 0.3.
-- =========================================================================
INSERT INTO decision_compatibility_score
  (dimension, profile_value, candidate_value, score, rationale, tenant_id, version, source)
VALUES
  -- modern row
  ('aesthetic', 'modern',     'modern',     1.00, 'perfect match',        NULL, 1, 'seed'),
  ('aesthetic', 'modern',     'classic',    0.30, 'mismatch',             NULL, 1, 'seed'),
  ('aesthetic', 'modern',     'eclectic',   0.70, 'compatible',           NULL, 1, 'seed'),
  ('aesthetic', 'modern',     'natural',    0.30, 'mismatch',             NULL, 1, 'seed'),
  ('aesthetic', 'modern',     'functional', 0.70, 'compatible',           NULL, 1, 'seed'),
  ('aesthetic', 'modern',     'neutral',    0.50, 'neutral candidate',    NULL, 1, 'seed'),
  -- classic row
  ('aesthetic', 'classic',    'modern',     0.30, 'mismatch',             NULL, 1, 'seed'),
  ('aesthetic', 'classic',    'classic',    1.00, 'perfect match',        NULL, 1, 'seed'),
  ('aesthetic', 'classic',    'eclectic',   0.30, 'mismatch',             NULL, 1, 'seed'),
  ('aesthetic', 'classic',    'natural',    0.70, 'compatible',           NULL, 1, 'seed'),
  ('aesthetic', 'classic',    'functional', 0.70, 'compatible',           NULL, 1, 'seed'),
  ('aesthetic', 'classic',    'neutral',    0.50, 'neutral candidate',    NULL, 1, 'seed'),
  -- eclectic row
  ('aesthetic', 'eclectic',   'modern',     0.70, 'compatible',           NULL, 1, 'seed'),
  ('aesthetic', 'eclectic',   'classic',    0.30, 'mismatch',             NULL, 1, 'seed'),
  ('aesthetic', 'eclectic',   'eclectic',   1.00, 'perfect match',        NULL, 1, 'seed'),
  ('aesthetic', 'eclectic',   'natural',    0.70, 'compatible',           NULL, 1, 'seed'),
  ('aesthetic', 'eclectic',   'functional', 0.30, 'mismatch',             NULL, 1, 'seed'),
  ('aesthetic', 'eclectic',   'neutral',    0.50, 'neutral candidate',    NULL, 1, 'seed'),
  -- natural row
  ('aesthetic', 'natural',    'modern',     0.30, 'mismatch',             NULL, 1, 'seed'),
  ('aesthetic', 'natural',    'classic',    0.70, 'compatible',           NULL, 1, 'seed'),
  ('aesthetic', 'natural',    'eclectic',   0.30, 'mismatch',             NULL, 1, 'seed'),
  ('aesthetic', 'natural',    'natural',    1.00, 'perfect match',        NULL, 1, 'seed'),
  ('aesthetic', 'natural',    'functional', 0.70, 'compatible',           NULL, 1, 'seed'),
  ('aesthetic', 'natural',    'neutral',    0.50, 'neutral candidate',    NULL, 1, 'seed'),
  -- functional row
  ('aesthetic', 'functional', 'modern',     0.70, 'compatible',           NULL, 1, 'seed'),
  ('aesthetic', 'functional', 'classic',    0.70, 'compatible',           NULL, 1, 'seed'),
  ('aesthetic', 'functional', 'eclectic',   0.30, 'mismatch',             NULL, 1, 'seed'),
  ('aesthetic', 'functional', 'natural',    0.70, 'compatible',           NULL, 1, 'seed'),
  ('aesthetic', 'functional', 'functional', 1.00, 'perfect match',        NULL, 1, 'seed'),
  ('aesthetic', 'functional', 'neutral',    0.50, 'neutral candidate',    NULL, 1, 'seed'),
  -- neutral row (profile=neutral → 0.5 across all candidates)
  ('aesthetic', 'neutral',    'modern',     0.50, 'neutral profile',      NULL, 1, 'seed'),
  ('aesthetic', 'neutral',    'classic',    0.50, 'neutral profile',      NULL, 1, 'seed'),
  ('aesthetic', 'neutral',    'eclectic',   0.50, 'neutral profile',      NULL, 1, 'seed'),
  ('aesthetic', 'neutral',    'natural',    0.50, 'neutral profile',      NULL, 1, 'seed'),
  ('aesthetic', 'neutral',    'functional', 0.50, 'neutral profile',      NULL, 1, 'seed'),
  ('aesthetic', 'neutral',    'neutral',    0.50, 'neutral both sides',   NULL, 1, 'seed')
ON CONFLICT DO NOTHING;

-- =========================================================================
-- D39 tone matrix — full 6×6 = 36 cells
-- d39-taste-alignment-service.ts scoreToneAlignment
-- Same semantics as aesthetic: diagonals=1.0; compatibilityMap=0.7;
-- neutral row/col = 0.5; remaining cells = 0.3.
-- =========================================================================
INSERT INTO decision_compatibility_score
  (dimension, profile_value, candidate_value, score, rationale, tenant_id, version, source)
VALUES
  -- technical row
  ('tone', 'technical',    'technical',    1.00, 'perfect match',        NULL, 1, 'seed'),
  ('tone', 'technical',    'expressive',   0.30, 'mismatch',             NULL, 1, 'seed'),
  ('tone', 'technical',    'casual',       0.30, 'mismatch',             NULL, 1, 'seed'),
  ('tone', 'technical',    'professional', 0.70, 'compatible',           NULL, 1, 'seed'),
  ('tone', 'technical',    'minimalist',   0.70, 'compatible',           NULL, 1, 'seed'),
  ('tone', 'technical',    'neutral',      0.50, 'neutral candidate',    NULL, 1, 'seed'),
  -- expressive row
  ('tone', 'expressive',   'technical',    0.30, 'mismatch',             NULL, 1, 'seed'),
  ('tone', 'expressive',   'expressive',   1.00, 'perfect match',        NULL, 1, 'seed'),
  ('tone', 'expressive',   'casual',       0.70, 'compatible',           NULL, 1, 'seed'),
  ('tone', 'expressive',   'professional', 0.30, 'mismatch',             NULL, 1, 'seed'),
  ('tone', 'expressive',   'minimalist',   0.30, 'mismatch',             NULL, 1, 'seed'),
  ('tone', 'expressive',   'neutral',      0.50, 'neutral candidate',    NULL, 1, 'seed'),
  -- casual row
  ('tone', 'casual',       'technical',    0.30, 'mismatch',             NULL, 1, 'seed'),
  ('tone', 'casual',       'expressive',   0.70, 'compatible',           NULL, 1, 'seed'),
  ('tone', 'casual',       'casual',       1.00, 'perfect match',        NULL, 1, 'seed'),
  ('tone', 'casual',       'professional', 0.30, 'mismatch',             NULL, 1, 'seed'),
  ('tone', 'casual',       'minimalist',   0.30, 'mismatch',             NULL, 1, 'seed'),
  ('tone', 'casual',       'neutral',      0.50, 'neutral candidate',    NULL, 1, 'seed'),
  -- professional row
  ('tone', 'professional', 'technical',    0.70, 'compatible',           NULL, 1, 'seed'),
  ('tone', 'professional', 'expressive',   0.30, 'mismatch',             NULL, 1, 'seed'),
  ('tone', 'professional', 'casual',       0.30, 'mismatch',             NULL, 1, 'seed'),
  ('tone', 'professional', 'professional', 1.00, 'perfect match',        NULL, 1, 'seed'),
  ('tone', 'professional', 'minimalist',   0.70, 'compatible',           NULL, 1, 'seed'),
  ('tone', 'professional', 'neutral',      0.50, 'neutral candidate',    NULL, 1, 'seed'),
  -- minimalist row
  ('tone', 'minimalist',   'technical',    0.70, 'compatible',           NULL, 1, 'seed'),
  ('tone', 'minimalist',   'expressive',   0.30, 'mismatch',             NULL, 1, 'seed'),
  ('tone', 'minimalist',   'casual',       0.30, 'mismatch',             NULL, 1, 'seed'),
  ('tone', 'minimalist',   'professional', 0.70, 'compatible',           NULL, 1, 'seed'),
  ('tone', 'minimalist',   'minimalist',   1.00, 'perfect match',        NULL, 1, 'seed'),
  ('tone', 'minimalist',   'neutral',      0.50, 'neutral candidate',    NULL, 1, 'seed'),
  -- neutral row (profile=neutral → 0.5 across all candidates)
  ('tone', 'neutral',      'technical',    0.50, 'neutral profile',      NULL, 1, 'seed'),
  ('tone', 'neutral',      'expressive',   0.50, 'neutral profile',      NULL, 1, 'seed'),
  ('tone', 'neutral',      'casual',       0.50, 'neutral profile',      NULL, 1, 'seed'),
  ('tone', 'neutral',      'professional', 0.50, 'neutral profile',      NULL, 1, 'seed'),
  ('tone', 'neutral',      'minimalist',   0.50, 'neutral profile',      NULL, 1, 'seed'),
  ('tone', 'neutral',      'neutral',      0.50, 'neutral both sides',   NULL, 1, 'seed')
ON CONFLICT DO NOTHING;

-- =========================================================================
-- D39 routine matrix — 3×2 = 6 cells
-- d39-taste-alignment-service.ts scoreRoutineAlignment
-- =========================================================================
INSERT INTO decision_compatibility_score
  (dimension, profile_value, candidate_value, score, rationale, tenant_id, version, source)
VALUES
  ('routine', 'structured', 'fixed',    1.00, 'perfect match',     NULL, 1, 'seed'),
  ('routine', 'structured', 'flexible', 0.40, 'partial mismatch',  NULL, 1, 'seed'),
  ('routine', 'flexible',   'fixed',    0.40, 'partial mismatch',  NULL, 1, 'seed'),
  ('routine', 'flexible',   'flexible', 1.00, 'perfect match',     NULL, 1, 'seed'),
  ('routine', 'hybrid',     'fixed',    0.70, 'compatible',        NULL, 1, 'seed'),
  ('routine', 'hybrid',     'flexible', 0.70, 'compatible',        NULL, 1, 'seed')
ON CONFLICT DO NOTHING;

-- =========================================================================
-- D39 social matrix — 4×3 = 12 cells
-- d39-taste-alignment-service.ts scoreSocialAlignment
-- =========================================================================
INSERT INTO decision_compatibility_score
  (dimension, profile_value, candidate_value, score, rationale, tenant_id, version, source)
VALUES
  ('social', 'solo_focused',    'solo',        1.00, 'perfect match',  NULL, 1, 'seed'),
  ('social', 'solo_focused',    'small_group', 0.50, 'neutral',        NULL, 1, 'seed'),
  ('social', 'solo_focused',    'large_group', 0.20, 'strong mismatch', NULL, 1, 'seed'),
  ('social', 'small_groups',    'solo',        0.50, 'neutral',        NULL, 1, 'seed'),
  ('social', 'small_groups',    'small_group', 1.00, 'perfect match',  NULL, 1, 'seed'),
  ('social', 'small_groups',    'large_group', 0.50, 'neutral',        NULL, 1, 'seed'),
  ('social', 'social_oriented', 'solo',        0.30, 'mismatch',       NULL, 1, 'seed'),
  ('social', 'social_oriented', 'small_group', 0.70, 'compatible',     NULL, 1, 'seed'),
  ('social', 'social_oriented', 'large_group', 1.00, 'perfect match',  NULL, 1, 'seed'),
  ('social', 'adaptive',        'solo',        0.50, 'neutral profile', NULL, 1, 'seed'),
  ('social', 'adaptive',        'small_group', 0.50, 'neutral profile', NULL, 1, 'seed'),
  ('social', 'adaptive',        'large_group', 0.50, 'neutral profile', NULL, 1, 'seed')
ON CONFLICT DO NOTHING;

-- =========================================================================
-- D39 convenience matrix — 3×3 = 9 cells
-- d39-taste-alignment-service.ts scoreConvenienceAlignment
-- =========================================================================
INSERT INTO decision_compatibility_score
  (dimension, profile_value, candidate_value, score, rationale, tenant_id, version, source)
VALUES
  ('convenience', 'convenience_first',  'low',    0.20, 'strong mismatch',  NULL, 1, 'seed'),
  ('convenience', 'convenience_first',  'medium', 0.60, 'partial fit',      NULL, 1, 'seed'),
  ('convenience', 'convenience_first',  'high',   1.00, 'perfect match',    NULL, 1, 'seed'),
  ('convenience', 'balanced',           'low',    0.50, 'neutral',          NULL, 1, 'seed'),
  ('convenience', 'balanced',           'medium', 1.00, 'perfect match',    NULL, 1, 'seed'),
  ('convenience', 'balanced',           'high',   0.70, 'compatible',       NULL, 1, 'seed'),
  ('convenience', 'intentional_living', 'low',    0.80, 'compatible',       NULL, 1, 'seed'),
  ('convenience', 'intentional_living', 'medium', 0.70, 'compatible',       NULL, 1, 'seed'),
  ('convenience', 'intentional_living', 'high',   0.40, 'partial mismatch', NULL, 1, 'seed')
ON CONFLICT DO NOTHING;

-- =========================================================================
-- D39 experience matrix — 3×3 = 9 cells
-- d39-taste-alignment-service.ts scoreExperienceAlignment
-- =========================================================================
INSERT INTO decision_compatibility_score
  (dimension, profile_value, candidate_value, score, rationale, tenant_id, version, source)
VALUES
  ('experience', 'digital_native',   'digital',  1.00, 'perfect match',    NULL, 1, 'seed'),
  ('experience', 'digital_native',   'hybrid',   0.70, 'compatible',       NULL, 1, 'seed'),
  ('experience', 'digital_native',   'physical', 0.30, 'mismatch',         NULL, 1, 'seed'),
  ('experience', 'physical_focused', 'digital',  0.30, 'mismatch',         NULL, 1, 'seed'),
  ('experience', 'physical_focused', 'hybrid',   0.60, 'partial fit',      NULL, 1, 'seed'),
  ('experience', 'physical_focused', 'physical', 1.00, 'perfect match',    NULL, 1, 'seed'),
  ('experience', 'blended',          'digital',  0.60, 'neutral profile',  NULL, 1, 'seed'),
  ('experience', 'blended',          'hybrid',   1.00, 'perfect match',    NULL, 1, 'seed'),
  ('experience', 'blended',          'physical', 0.60, 'neutral profile',  NULL, 1, 'seed')
ON CONFLICT DO NOTHING;

-- =========================================================================
-- D39 novelty matrix — 3×3 = 9 cells
-- d39-taste-alignment-service.ts scoreNoveltyAlignment
-- =========================================================================
INSERT INTO decision_compatibility_score
  (dimension, profile_value, candidate_value, score, rationale, tenant_id, version, source)
VALUES
  ('novelty', 'conservative', 'familiar', 1.00, 'perfect match',     NULL, 1, 'seed'),
  ('novelty', 'conservative', 'moderate', 0.60, 'partial fit',       NULL, 1, 'seed'),
  ('novelty', 'conservative', 'novel',    0.20, 'strong mismatch',   NULL, 1, 'seed'),
  ('novelty', 'moderate',     'familiar', 0.60, 'partial fit',       NULL, 1, 'seed'),
  ('novelty', 'moderate',     'moderate', 1.00, 'perfect match',     NULL, 1, 'seed'),
  ('novelty', 'moderate',     'novel',    0.60, 'partial fit',       NULL, 1, 'seed'),
  ('novelty', 'explorer',     'familiar', 0.40, 'partial mismatch',  NULL, 1, 'seed'),
  ('novelty', 'explorer',     'moderate', 0.70, 'compatible',        NULL, 1, 'seed'),
  ('novelty', 'explorer',     'novel',    1.00, 'perfect match',     NULL, 1, 'seed')
ON CONFLICT DO NOTHING;

-- =========================================================================
-- D39 PR 5b also-seeds — three decision_policy JSONB rows the PR 5f
-- consumer wiring will eventually read. Data only; no code reads them
-- yet. Uses the canonical `WHERE NOT EXISTS` idempotency idiom that
-- the decision_policy table has used since VTID-03113 (its UNIQUE
-- constraint pre-dates NULLS NOT DISTINCT — see decision_conflict_pair
-- + VTID-03140 / VTID-03142 prior seed migrations for the same shape).
-- =========================================================================

-- A. scoring weights — 9 dimension weights (taste 4 × 0.25; lifestyle
-- 0.20/0.25/0.20/0.15/0.20). Mirrors the SCORING_WEIGHTS constant.
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'taste_alignment.scoring_weights', NULL, 1,
       '{
         "version": 1,
         "weights": {
           "simplicity":  0.25,
           "premium":     0.25,
           "aesthetic":   0.25,
           "tone":        0.25,
           "routine":     0.20,
           "social":      0.25,
           "convenience": 0.20,
           "experience":  0.15,
           "novelty":     0.20
         }
       }'::jsonb,
       'seed', 'd39-taste-alignment-service.ts SCORING_WEIGHTS'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'taste_alignment.scoring_weights'
    AND tenant_id IS NULL AND version = 1
);

-- B. tuning thresholds — 6 scalars (exclude/reframe/good_fit/
-- confidence_min_scoring/sparse_data/exploration_boost). Mirrors the
-- ALIGNMENT_THRESHOLDS constant.
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'taste_alignment.thresholds', NULL, 1,
       '{
         "version": 1,
         "thresholds": {
           "exclude":                0.3,
           "reframe":                0.5,
           "good_fit":               0.7,
           "confidence_min_scoring": 20,
           "sparse_data":            30,
           "exploration_boost":      0.1
         }
       }'::jsonb,
       'seed', 'd39-taste-alignment-service.ts ALIGNMENT_THRESHOLDS'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'taste_alignment.thresholds'
    AND tenant_id IS NULL AND version = 1
);

-- C. tag emission rules — 10 (profile_dim, profile_value) → tag
-- mappings. Mirrors generateAlignmentTags. The PR 5f resolver will
-- iterate this list to emit AlignmentTag values for good-fit actions.
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'taste_alignment.tag_emission', NULL, 1,
       '{
         "version": 1,
         "rules": [
           { "dimension": "simplicity_preference", "value": "minimalist",        "tag": "minimalist_fit"     },
           { "dimension": "premium_orientation",   "value": "premium_oriented",  "tag": "premium_fit"        },
           { "dimension": "aesthetic_style",       "value": "classic",           "tag": "classic_style"      },
           { "dimension": "aesthetic_style",       "value": "modern",            "tag": "modern_fit"         },
           { "dimension": "convenience_bias",      "value": "convenience_first", "tag": "convenience_first"  },
           { "dimension": "novelty_tolerance",     "value": "explorer",          "tag": "exploratory_ok"     },
           { "dimension": "social_orientation",    "value": "solo_focused",      "tag": "solo_appropriate"   },
           { "dimension": "social_orientation",    "value": "social_oriented",   "tag": "social_appropriate" },
           { "dimension": "routine_style",         "value": "structured",        "tag": "routine_compatible" },
           { "dimension": "routine_style",         "value": "flexible",          "tag": "flexible_fit"       }
         ]
       }'::jsonb,
       'seed', 'd39-taste-alignment-service.ts generateAlignmentTags'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'taste_alignment.tag_emission'
    AND tenant_id IS NULL AND version = 1
);
