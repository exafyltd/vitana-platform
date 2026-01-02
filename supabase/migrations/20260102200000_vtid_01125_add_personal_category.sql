-- ===========================================================================
-- VTID-01125: Add missing 'personal' category to memory_categories
-- ===========================================================================
--
-- Problem: The orb-memory-bridge classifyDevCategory() function returns 'personal'
-- for user identity information (name, hometown, age, etc.) but this category
-- was missing from the memory_categories table, causing foreign key violations:
--
--   "insert or update on table memory_items violates foreign key constraint
--    memory_items_category_key_fkey"
--
-- This prevented ORB from storing ANY personal identity information, which is
-- the core reason memory wasn't working across sessions.
-- ===========================================================================

-- Add the 'personal' category
INSERT INTO public.memory_categories (key, label) VALUES
    ('personal', 'Personal Identity')
ON CONFLICT (key) DO NOTHING;

-- Verify the fix
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.memory_categories WHERE key = 'personal') THEN
        RAISE NOTICE 'VTID-01125: personal category added successfully';
    ELSE
        RAISE WARNING 'VTID-01125: Failed to add personal category';
    END IF;
END $$;
