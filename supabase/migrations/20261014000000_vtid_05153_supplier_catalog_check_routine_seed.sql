-- VTID-05153: Loop Engineering Phase 5 (L9 Supplier catalog, wave 1) — catalog
-- row for the new gateway-runner routine supplier-catalog-check.
-- routine_runs.routine_name has a foreign key on routines(name), so the
-- routine needs its catalog row before its first run.
--
-- Additive and idempotent: an existing row is left untouched. No table, no
-- column, no change to products (the routine's per-row result lives in the
-- reserved jsonb key products.attributes.catalog_check).

BEGIN;

INSERT INTO public.routines (name, display_name, description, cron_schedule, enabled)
VALUES
  (
    'supplier-catalog-check',
    'Supplier Catalog Check (L9)',
    'Daily (13:00 UTC): deterministic checks of at most 20 supplier rows of the supplements category per run (normalize, required fields and money, duplicates within the supplier, image probe, claim pre-screen); one result per row in products.attributes.catalog_check; three identical failures return the row to the supplier via the checklist (catalogue_fixes) and MCP next_action. Never publishes, never writes is_active, no LLM. Spec: routines/supplier-catalog-check.md.',
    '0 13 * * *',
    true
  )
ON CONFLICT (name) DO NOTHING;

COMMIT;
