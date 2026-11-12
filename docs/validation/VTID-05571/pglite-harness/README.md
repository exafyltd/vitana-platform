Local harness (outside the repo): PGlite (PG18 wasm) + pgTAP-compatible shim.
  LANE_MIGRATIONS="supabase/migrations/2026110204xxxx_..." ./lane.sh supabase/tests/<file>.test.sql
Loads base_schema.sql (stand-ins for tenants/app_users/user_tenants/profiles/memory_*/chat_messages/user_notifications),
the REAL legacy writer migrations (01127 supabase; 01135/37/38/39/42/43/44 database; 01146 supabase), then the lane files.
Limits: not the full production schema; no pgTAP catalog assertions (has_table etc.); Real pgTAP on a Supabase stack still authoritative.
