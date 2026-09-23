-- VTID-04389: copy the Memory Garden's legacy content into the canonical store.
--
-- Until now the Garden UI read `ai_memory` (112 active rows, last write
-- 2025-11-10) and `diary_entries` (273 rows) directly. It now reads
-- /api/v1/memory/garden, i.e. memory_facts + memory_items. This copies both
-- legacy sources into memory_items as episodes so nothing a user saw in the
-- Garden disappears. Additive and idempotent: each copy carries the source row
-- id (content_json.legacy_ai_memory_id / diary_entry_id) and is skipped when a
-- copy already exists. The legacy tables are not touched.
--
-- Embeddings stay NULL; AP-0910 (or embed-on-write for new rows) fills them.
--
-- Importance is 50 or less on purpose: trg_notify_memory_garden inserts a
-- 'memory_garden_grew' notification for every memory_items row with
-- importance > 50, and a backfill must not notify real members.

-- The 13 Garden categories become valid memory_items.category_key values
-- (memory_category_mapping already maps each to itself), so a Garden note or a
-- diary entry tagged with a Garden category can be stored under it. And the
-- existing 'personal' key was never mapped; it is personal identity.
INSERT INTO public.memory_categories (key, label, is_active) VALUES
  ('personal_identity', 'Personal Identity', true),
  ('health_wellness', 'Health & Wellness', true),
  ('lifestyle_routines', 'Lifestyle & Routines', true),
  ('network_relationships', 'Network & Relationships', true),
  ('learning_knowledge', 'Learning & Knowledge', true),
  ('business_projects', 'Business & Projects', true),
  ('finance_assets', 'Finance & Assets', true),
  ('location_environment', 'Location & Environment', true),
  ('digital_footprint', 'Digital Footprint', true),
  ('values_aspirations', 'Values & Aspirations', true),
  ('autopilot_context', 'Autopilot & Context', true),
  ('future_plans', 'Future Plans', true),
  ('uncategorized', 'Uncategorized', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.memory_category_mapping (source_category, garden_category)
SELECT 'personal', 'personal_identity'
WHERE NOT EXISTS (SELECT 1 FROM public.memory_category_mapping WHERE source_category = 'personal');

INSERT INTO public.memory_items
  (tenant_id, user_id, category_key, source, content, content_json, importance, occurred_at, provenance_source, provenance_confidence)
SELECT ut.tenant_id,
       a.user_id,
       CASE a.memory_type WHEN 'preference' THEN 'preferences' WHEN 'goal' THEN 'goals' ELSE 'notes' END,
       'system',
       a.content,
       jsonb_build_object('kind', 'legacy_ai_memory', 'legacy_ai_memory_id', a.id, 'memory_type', a.memory_type),
       40,
       a.created_at,
       'assistant_inferred',
       LEAST(GREATEST(COALESCE(a.confidence_score, 0.7), 0), 1)
FROM public.ai_memory a
JOIN LATERAL (SELECT tenant_id FROM public.user_tenants WHERE user_id = a.user_id ORDER BY is_primary DESC NULLS LAST LIMIT 1) ut ON true
WHERE a.is_active
  AND coalesce(trim(a.content), '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.memory_items mi
    WHERE mi.user_id = a.user_id AND mi.content_json->>'legacy_ai_memory_id' = a.id::text
  );

INSERT INTO public.memory_items
  (tenant_id, user_id, category_key, source, content, content_json, importance, occurred_at)
SELECT ut.tenant_id,
       d.user_id,
       COALESCE((
         SELECT replace(lower(t), '-', '_') FROM unnest(d.tags) t
         WHERE replace(lower(t), '-', '_') IN ('personal_identity','health_wellness','lifestyle_routines','network_relationships',
           'learning_knowledge','business_projects','finance_assets','location_environment','digital_footprint',
           'values_aspirations','autopilot_context','future_plans')
         LIMIT 1), 'notes'),
       'diary',
       d.text,
       jsonb_build_object('kind', 'diary', 'diary_entry_id', d.id, 'diary_source', d.source, 'tags', to_jsonb(d.tags)),
       50,
       d.created_at
FROM public.diary_entries d
JOIN LATERAL (SELECT tenant_id FROM public.user_tenants WHERE user_id = d.user_id ORDER BY is_primary DESC NULLS LAST LIMIT 1) ut ON true
WHERE coalesce(trim(d.text), '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.memory_items mi
    WHERE mi.user_id = d.user_id AND mi.content_json->>'diary_entry_id' = d.id::text
  );
