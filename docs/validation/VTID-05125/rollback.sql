-- VTID-05125 rollback — NOT a migration (kept out of supabase/migrations on
-- purpose). Run by hand, with the owner's go, only if something unexpected
-- needs `migrate` to execute these functions again (nothing in DMS's design
-- or the repo does). Restores exactly the 2026-10-12 before-state
-- (docs/validation/VTID-05125/live-before.sql).
BEGIN;
GRANT EXECUTE ON FUNCTION public.write_fact(uuid, uuid, text, text, text, text, text, uuid, numeric, uuid) TO migrate;
GRANT EXECUTE ON FUNCTION public.get_current_facts(uuid, uuid, text, text[]) TO migrate;
GRANT EXECUTE ON FUNCTION public.recall_at_time_range(uuid, timestamp with time zone, timestamp with time zone, text) TO migrate;
GRANT EXECUTE ON FUNCTION public.memory_facts_semantic_search(vector, integer, uuid, uuid, text, numeric) TO migrate;
COMMIT;
