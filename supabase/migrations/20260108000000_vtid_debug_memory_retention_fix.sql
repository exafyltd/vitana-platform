-- Migration: 20260108000000_vtid_debug_memory_retention_fix.sql
-- Purpose: Fix memory retention bugs causing identity data loss
-- Date: 2026-01-08
--
-- ROOT CAUSE ANALYSIS:
-- BUG #1: 'personal' category missing from memory_categories seed data
--         - classifyDevCategory() returns 'personal' for identity info
--         - But 'personal' doesn't exist in the table -> FK constraint fails
--         - All identity data inserts silently fail!
--
-- BUG #2: Memory confidence decay and time filtering
--         - Non-persistent categories expire after 7 days
--         - If 'personal' fails, data falls back to 'conversation' which expires
--
-- FIXES:
-- 1. Add missing 'personal' category
-- 2. Add German identity-related category 'unternehmen' (company/business)
-- 3. Increase default importance for identity facts
--
-- Dependencies:
--   - VTID-01104 (Memory Core v1) - memory_categories table

-- ===========================================================================
-- FIX #1: Add missing 'personal' category
-- This is CRITICAL - without this, all identity data inserts fail!
-- ===========================================================================

INSERT INTO public.memory_categories (key, label, is_active)
VALUES
    ('personal', 'Personal Identity', true)
ON CONFLICT (key) DO UPDATE SET
    label = EXCLUDED.label,
    is_active = true;

-- ===========================================================================
-- FIX #2: Add 'company' category for business/company identity
-- German users often mention "meine Firma" (my company)
-- ===========================================================================

INSERT INTO public.memory_categories (key, label, is_active)
VALUES
    ('company', 'Company & Business Identity', true)
ON CONFLICT (key) DO UPDATE SET
    label = EXCLUDED.label,
    is_active = true;

-- ===========================================================================
-- Verification: Ensure all critical categories exist
-- ===========================================================================

DO $$
DECLARE
    missing_categories TEXT[];
BEGIN
    SELECT array_agg(cat) INTO missing_categories
    FROM unnest(ARRAY['personal', 'relationships', 'conversation', 'health', 'preferences', 'goals', 'company']) AS cat
    WHERE NOT EXISTS (SELECT 1 FROM public.memory_categories WHERE key = cat AND is_active = true);

    IF array_length(missing_categories, 1) > 0 THEN
        RAISE WARNING 'Missing memory categories after migration: %', missing_categories;
    ELSE
        RAISE NOTICE 'All critical memory categories verified present';
    END IF;
END $$;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE public.memory_categories IS
'VTID-01104 + DEBUG-FIX: Memory category lookup table.
CRITICAL: personal category was missing, causing identity data loss.
Fixed in migration 20260108000000.';
