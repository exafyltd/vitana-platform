-- VTID-05010 data fix-up: the memory episode for two voice diary entries that the
-- voice diary tool saved without one, before VTID-04884 (PR #3913) fixed the tool.
-- Owner OK for exactly these two rows: 2026-10-09, in the session that ran the
-- sparred plan (docs/validation/VTID-05010/plan-sparring.md).
--
--   a1a77e84-6db9-466d-8257-9376f0a6bc4f   2026-09-24 15:52 UTC   voice, 372 chars
--   6b40de35-72c3-42da-9bba-5d82c27cbe96   2026-09-26 09:14 UTC   voice, 196 chars
--
-- Counted read-only 2026-10-09: both rows have 0 episodes, and each user has
-- exactly one user_tenants row, which is primary.
--
-- Same shape as writeDiaryEpisode() (services/gateway/src/services/memory/diary.ts):
-- personal (active_role NULL), source 'diary', category from the row's tags
-- (diary/voice/orb -> 'notes'), importance 50 (trg_notify_memory_garden fires only
-- above 50, so no member is notified), content = the row's text, occurred_at = the
-- row's created_at, content_json = {kind, diary_entry_id, diary_source, tags} from
-- the row itself. Not set here: sensitivity (trg_memory_items_sensitivity sets it),
-- embedding (AP-0910's in-process backfill fills it), id/created_at (defaults).
--
-- Idempotent: a row that already has an episode for its diary_entry_id is skipped,
-- so a second run inserts nothing. Aborts if a row is missing or its user has no
-- primary tenant, instead of repairing half.

BEGIN;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM public.diary_entries d
    JOIN public.user_tenants ut ON ut.user_id = d.user_id AND ut.is_primary
   WHERE d.id IN ('a1a77e84-6db9-466d-8257-9376f0a6bc4f', '6b40de35-72c3-42da-9bba-5d82c27cbe96');
  IF n <> 2 THEN
    RAISE EXCEPTION 'VTID-05010: expected 2 diary rows with a primary tenant, found %', n;
  END IF;
END $$;

DO $$
DECLARE inserted int;
BEGIN
  INSERT INTO public.memory_items
    (tenant_id, user_id, active_role, source, category_key, content, content_json, importance, occurred_at)
  SELECT ut.tenant_id,
         d.user_id,
         NULL,
         'diary',
         'notes',
         d.text,
         jsonb_build_object(
           'kind', 'diary',
           'diary_entry_id', d.id::text,
           'diary_source', d.source,
           'tags', to_jsonb(coalesce(d.tags, ARRAY['diary', d.source]))
         ),
         50,
         d.created_at
    FROM public.diary_entries d
    JOIN public.user_tenants ut ON ut.user_id = d.user_id AND ut.is_primary
   WHERE d.id IN ('a1a77e84-6db9-466d-8257-9376f0a6bc4f', '6b40de35-72c3-42da-9bba-5d82c27cbe96')
     AND coalesce(d.text, '') <> ''
     AND NOT EXISTS (
       SELECT 1 FROM public.memory_items m
        WHERE m.user_id = d.user_id
          AND m.content_json->>'diary_entry_id' = d.id::text
     );
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RAISE NOTICE 'VTID-05010: voice diary episodes inserted: %', inserted;
END $$;

COMMIT;
