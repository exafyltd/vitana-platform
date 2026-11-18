Local harness (outside CI): PGlite + a pgTAP-compatible shim. Stand-in schema in base_schema.sql (profiles keyed by user_id like production).
  EXTRA_MIG="supabase/migrations/<file>" ./lane.sh supabase/tests/<file>.test.sql   (run from the repo root)
  node checks.mjs   (both migrations + pre/post/rollback checks + rollback file)
Real pgTAP on a Supabase stack is authoritative.
