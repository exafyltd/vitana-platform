-- Migration: 20260203000000_vtid_01225_extend_memory_category_mapping.sql
-- Purpose: VTID-01225 Cognee Integration - Extend memory category mappings
-- Date: 2026-02-03
--
-- Adds self-mappings for Memory Garden categories that were missing from the
-- original memory_category_mapping table. This allows entities to be written
-- directly using garden category keys.
--
-- Original mappings (from VTID-01086):
--   conversation → uncategorized
--   health → health_wellness
--   relationships → network_relationships
--   community → network_relationships
--   preferences → lifestyle_routines
--   goals → values_aspirations
--   tasks → business_projects
--   products_services → finance_assets
--   events_meetups → network_relationships
--   notes → uncategorized
--
-- Missing garden categories that need self-mappings:
--   personal_identity, learning_knowledge, location_environment,
--   digital_footprint, autopilot_context, future_plans
--
-- Dependencies:
--   - VTID-01086 (memory_category_mapping table)

-- ===========================================================================
-- Add self-mappings for remaining Memory Garden categories
-- ===========================================================================

INSERT INTO public.memory_category_mapping (source_category, garden_category) VALUES
    -- Personal Identity - core user profile facts
    ('personal_identity', 'personal_identity'),

    -- Learning & Knowledge - skills, education
    ('learning_knowledge', 'learning_knowledge'),
    ('learning', 'learning_knowledge'),
    ('knowledge', 'learning_knowledge'),
    ('education', 'learning_knowledge'),
    ('skills', 'learning_knowledge'),

    -- Location & Environment - places, travel
    ('location_environment', 'location_environment'),
    ('location', 'location_environment'),
    ('environment', 'location_environment'),
    ('travel', 'location_environment'),
    ('places', 'location_environment'),

    -- Digital Footprint - online presence
    ('digital_footprint', 'digital_footprint'),
    ('digital', 'digital_footprint'),
    ('online', 'digital_footprint'),

    -- Autopilot Context - AI companion settings
    ('autopilot_context', 'autopilot_context'),
    ('autopilot', 'autopilot_context'),
    ('ai_context', 'autopilot_context'),

    -- Future Plans - goals, milestones
    ('future_plans', 'future_plans'),
    ('plans', 'future_plans'),
    ('milestones', 'future_plans'),

    -- Also add self-mappings for existing garden categories (for direct writes)
    ('health_wellness', 'health_wellness'),
    ('lifestyle_routines', 'lifestyle_routines'),
    ('network_relationships', 'network_relationships'),
    ('business_projects', 'business_projects'),
    ('finance_assets', 'finance_assets'),
    ('values_aspirations', 'values_aspirations'),
    ('uncategorized', 'uncategorized')
ON CONFLICT (source_category) DO UPDATE SET
    garden_category = EXCLUDED.garden_category;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE public.memory_category_mapping IS
  'VTID-01086 + VTID-01225: Maps memory_items categories to garden categories. Extended with self-mappings for all 13 garden categories.';
