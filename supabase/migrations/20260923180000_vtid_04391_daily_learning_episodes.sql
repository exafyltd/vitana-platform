-- VTID-04391: one daily_learning episode per user per local date.
--
-- Written by AP-0914 (services/gateway/src/services/memory/daily-learning.ts)
-- in the user's own evening, read by recall and by the Daily summary screen
-- (GET /api/v1/memory/daily-learning). The unique index makes a second insert
-- for the same (user, date) fail with 23505, treated as already written.

INSERT INTO public.memory_categories (key, label, is_active)
VALUES ('daily_learning', 'Daily learnings', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.memory_category_mapping (source_category, garden_category)
SELECT 'daily_learning', 'uncategorized'
WHERE NOT EXISTS (SELECT 1 FROM public.memory_category_mapping WHERE source_category = 'daily_learning');

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_items_daily_learning
  ON public.memory_items (user_id, ((content_json->>'date')))
  WHERE category_key = 'daily_learning';

COMMENT ON INDEX public.uq_memory_items_daily_learning IS
  'VTID-04391: at most one daily_learning episode per (user, local date).';
