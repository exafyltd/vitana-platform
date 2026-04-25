-- VTID-01952 — Relax memory_facts.provenance_source CHECK constraint (Phase 0 hotfix)
--
-- The original VTID-01192 column-level CHECK only allowed three legacy values:
--   'user_stated', 'assistant_inferred', 'system_observed'
--
-- The Identity Lock trigger (migration 20260426000001) introduced six new
-- authorized provenance sources for the Profile/Settings UI write path. The
-- old column constraint blocks them — so legitimate UI writes hit the wrong
-- error message ("violates check constraint memory_facts_provenance_source_check")
-- instead of going through the trigger.
--
-- Fix: drop the column CHECK and replace with the expanded set. The Identity
-- Lock trigger remains the authority on which sources can write which keys.
--
-- Verified before this fix: cognee writes (assistant_inferred) are correctly
-- rejected by the trigger; user_stated_via_settings writes were rejected by
-- the column constraint instead of being allowed by the trigger.
--
-- Plan: /home/dstev/.claude/plans/the-vitana-system-has-wild-puffin.md  Part 1.5

BEGIN;

-- Drop the legacy constraint added in vtid_01192_infinite_memory_v2.sql
ALTER TABLE public.memory_facts
  DROP CONSTRAINT IF EXISTS memory_facts_provenance_source_check;

-- Re-add with the expanded authorized set. Both legacy values
-- ('user_stated', 'assistant_inferred', 'system_observed') stay allowed —
-- the trigger blocks them only for identity-class fact_keys. Non-identity
-- writes (favorite_food, sleep_routine, etc.) continue to use them.
ALTER TABLE public.memory_facts
  ADD CONSTRAINT memory_facts_provenance_source_check
  CHECK (provenance_source IN (
    -- Legacy (still valid for non-identity facts)
    'user_stated',
    'assistant_inferred',
    'system_observed',
    -- Identity-authorized UI surfaces (VTID-01952 Phase 0)
    'user_stated_via_settings',
    'user_stated_via_memory_garden_ui',
    'user_stated_via_onboarding',
    'user_stated_via_baseline_survey',
    -- System actors
    'admin_correction',
    'system_provision',
    'consolidator'
  ));

COMMIT;

-- =====================================================================
-- VERIFICATION (run after migration applies):
--
-- Allow path that was previously blocked:
--   INSERT INTO memory_facts (tenant_id, user_id, entity, fact_key, fact_value, provenance_source, provenance_confidence)
--   VALUES (gen_random_uuid(), gen_random_uuid(), 'self', 'user_first_name', 'TestMaria', 'user_stated_via_settings', 1.0);
--   -- Expected: 1 row inserted (column constraint allows + trigger allows).
--
-- Identity Lock trigger still rejects unauthorized:
--   INSERT INTO memory_facts (tenant_id, user_id, entity, fact_key, fact_value, provenance_source, provenance_confidence)
--   VALUES (gen_random_uuid(), gen_random_uuid(), 'self', 'user_first_name', 'Kemal', 'assistant_inferred', 0.85);
--   -- Expected: ERROR identity_locked (from trigger, not column constraint).
-- =====================================================================
