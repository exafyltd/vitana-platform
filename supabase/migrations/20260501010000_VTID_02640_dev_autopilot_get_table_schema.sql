-- =============================================================================
-- VTID-02640: dev_autopilot_get_table_schema RPC
-- =============================================================================
-- Dev Autopilot's planner has been hallucinating column names — most
-- visibly in the closed PR #1091 which proposed renaming `vitana_id`
-- across all auth code to `vuid` (the `vuid` column does not exist; the
-- canonical column is `vitana_id`, used in 40+ places). The LLM had no
-- visibility into the live schema and inferred the rename from filename
-- patterns alone.
--
-- This RPC is the substrate for the planner-prompt schema-context
-- injection (gateway change in this same VTID): the planner detects
-- table names referenced in the flagged file and pre-fetches their
-- column lists so the LLM can verify any column it cites against the
-- actual schema instead of guessing.
--
-- The function is intentionally narrow (public schema only, columns
-- only) — it is NOT a general-purpose introspection API. RPC, SECURITY
-- DEFINER, restricted to service_role, only callable with an explicit
-- table-name allowlist. Cached in-process by the gateway for 60s to keep
-- planning latency low.
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION public.dev_autopilot_get_table_schema(p_tables TEXT[])
RETURNS TABLE (
  table_name     TEXT,
  column_name    TEXT,
  data_type      TEXT,
  is_nullable    TEXT,
  column_default TEXT,
  ordinal_position INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    c.table_name::TEXT,
    c.column_name::TEXT,
    c.data_type::TEXT,
    c.is_nullable::TEXT,
    c.column_default::TEXT,
    c.ordinal_position::INT
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = ANY(p_tables)
  ORDER BY c.table_name, c.ordinal_position;
$$;

REVOKE ALL ON FUNCTION public.dev_autopilot_get_table_schema(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dev_autopilot_get_table_schema(TEXT[]) TO service_role;

-- Smoke test: the planner always asks for at least one table; verify the
-- function returns rows for a known core table without erroring.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.dev_autopilot_get_table_schema(ARRAY['app_users']);
  IF v_count = 0 THEN
    RAISE EXCEPTION 'VTID-02640 sanity: dev_autopilot_get_table_schema returned 0 columns for app_users — schema lookup likely broken';
  END IF;
  RAISE NOTICE 'VTID-02640 applied: dev_autopilot_get_table_schema(app_users) returned % columns', v_count;
END $$;

COMMIT;
