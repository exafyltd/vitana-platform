-- Migration: 20251231000001_vtid_01086_memory_garden_progress.sql
-- Purpose: VTID-01086 Memory Garden UI Deepening - Progress endpoint support
-- Date: 2025-12-31
--
-- Adds Memory Garden categories and RPC for progress tracking.
-- Maps existing memory_items categories to garden categories for aggregation.
--
-- Dependencies:
--   - VTID-01104 (memory_items, memory_categories)

-- ===========================================================================
-- Memory Garden Category Configuration
-- ===========================================================================

-- Memory Garden category targets (for progress calculation)
-- Target counts represent the number of memories needed to reach 100% progress
CREATE TABLE IF NOT EXISTS public.memory_garden_config (
    category_key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    icon TEXT NULL,
    target_count INT NOT NULL DEFAULT 50,
    description TEXT NULL,
    longevity_message TEXT NULL,  -- "Why this matters" for longevity
    display_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed Memory Garden categories with targets and longevity messaging
INSERT INTO public.memory_garden_config (category_key, label, icon, target_count, description, longevity_message, display_order) VALUES
    ('personal_identity', 'Personal Identity', 'user', 30, 'Core facts about who you are', 'Self-awareness correlates with lower stress and better decision-making', 1),
    ('health_wellness', 'Health & Wellness', 'heart', 50, 'Your health data, habits, and goals', 'Health tracking enables early intervention and lifestyle optimization', 2),
    ('lifestyle_routines', 'Lifestyle & Routines', 'calendar', 40, 'Daily habits and recurring patterns', 'Consistent routines reduce cognitive load and improve sleep quality', 3),
    ('network_relationships', 'Network & Relationships', 'users', 35, 'People in your life and connections', 'Strong social connections add years to lifespan and improve mental health', 4),
    ('learning_knowledge', 'Learning & Knowledge', 'book', 30, 'Skills, education, and continuous learning', 'Lifelong learning protects cognitive function and builds brain reserve', 5),
    ('business_projects', 'Business & Projects', 'briefcase', 25, 'Work, projects, and professional life', 'Purpose and productivity contribute to longevity and life satisfaction', 6),
    ('finance_assets', 'Finance & Assets', 'dollar-sign', 20, 'Financial health and resources', 'Financial security reduces chronic stress and enables health investments', 7),
    ('location_environment', 'Location & Environment', 'map-pin', 15, 'Places, travel, and living environment', 'Environment quality directly impacts lifespan through air, water, and safety', 8),
    ('digital_footprint', 'Digital Footprint', 'monitor', 20, 'Online presence and digital life', 'Digital boundaries protect mental health and attention capacity', 9),
    ('values_aspirations', 'Values & Aspirations', 'star', 20, 'What matters to you and future goals', 'Clear values and purpose are associated with longer, healthier lives', 10),
    ('autopilot_context', 'Autopilot Context', 'cpu', 15, 'Context for AI assistance', 'Personalized AI support optimizes daily decisions and reduces friction', 11),
    ('future_plans', 'Future Plans', 'compass', 15, 'Goals, milestones, and planning', 'Goal-setting and future orientation predict better health outcomes', 12),
    ('uncategorized', 'Uncategorized', 'folder', 50, 'Memories awaiting classification', NULL, 13)
ON CONFLICT (category_key) DO UPDATE SET
    label = EXCLUDED.label,
    icon = EXCLUDED.icon,
    target_count = EXCLUDED.target_count,
    description = EXCLUDED.description,
    longevity_message = EXCLUDED.longevity_message,
    display_order = EXCLUDED.display_order;

-- Enable RLS
ALTER TABLE public.memory_garden_config ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read config (it's a lookup table)
DROP POLICY IF EXISTS memory_garden_config_select ON public.memory_garden_config;
CREATE POLICY memory_garden_config_select ON public.memory_garden_config
    FOR SELECT
    TO authenticated
    USING (is_active = true);

-- ===========================================================================
-- Category Mapping Table
-- Maps existing memory_items categories to garden categories
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memory_category_mapping (
    source_category TEXT PRIMARY KEY,
    garden_category TEXT NOT NULL REFERENCES public.memory_garden_config(category_key)
);

-- Seed mappings from existing categories to garden categories
INSERT INTO public.memory_category_mapping (source_category, garden_category) VALUES
    ('conversation', 'uncategorized'),
    ('health', 'health_wellness'),
    ('relationships', 'network_relationships'),
    ('community', 'network_relationships'),
    ('preferences', 'lifestyle_routines'),
    ('goals', 'values_aspirations'),
    ('tasks', 'business_projects'),
    ('products_services', 'finance_assets'),
    ('events_meetups', 'network_relationships'),
    ('notes', 'uncategorized')
ON CONFLICT (source_category) DO UPDATE SET
    garden_category = EXCLUDED.garden_category;

-- Enable RLS
ALTER TABLE public.memory_category_mapping ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read mappings
DROP POLICY IF EXISTS memory_category_mapping_select ON public.memory_category_mapping;
CREATE POLICY memory_category_mapping_select ON public.memory_category_mapping
    FOR SELECT
    TO authenticated
    USING (true);

-- ===========================================================================
-- RPC: memory_get_garden_progress
-- Returns counts and progress per garden category
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_get_garden_progress()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_categories JSONB;
    v_total_count INT;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Get total memory count
    SELECT COUNT(*)
    INTO v_total_count
    FROM public.memory_items mi
    WHERE mi.tenant_id = v_tenant_id
      AND mi.user_id = v_user_id;

    -- Aggregate counts by garden category, mapped from memory_items
    -- Use COALESCE to handle categories with zero counts
    WITH category_counts AS (
        SELECT
            COALESCE(m.garden_category, 'uncategorized') as garden_category,
            COUNT(mi.id) as item_count
        FROM public.memory_items mi
        LEFT JOIN public.memory_category_mapping m ON mi.category_key = m.source_category
        WHERE mi.tenant_id = v_tenant_id
          AND mi.user_id = v_user_id
        GROUP BY COALESCE(m.garden_category, 'uncategorized')
    ),
    all_categories AS (
        SELECT
            gc.category_key,
            gc.label,
            gc.icon,
            gc.target_count,
            gc.description,
            gc.longevity_message,
            gc.display_order,
            COALESCE(cc.item_count, 0) as count,
            LEAST(1.0, COALESCE(cc.item_count, 0)::NUMERIC / GREATEST(gc.target_count, 1)) as progress
        FROM public.memory_garden_config gc
        LEFT JOIN category_counts cc ON gc.category_key = cc.garden_category
        WHERE gc.is_active = true
        ORDER BY gc.display_order
    )
    SELECT jsonb_object_agg(
        ac.category_key,
        jsonb_build_object(
            'count', ac.count,
            'progress', ROUND(ac.progress::NUMERIC, 2),
            'label', ac.label,
            'icon', ac.icon,
            'target_count', ac.target_count,
            'description', ac.description,
            'longevity_message', ac.longevity_message
        )
    )
    INTO v_categories
    FROM all_categories ac;

    -- Return success with categories and totals
    RETURN jsonb_build_object(
        'ok', true,
        'totals', jsonb_build_object('memories', COALESCE(v_total_count, 0)),
        'categories', COALESCE(v_categories, '{}'::JSONB)
    );
END;
$$;

-- ===========================================================================
-- Permissions
-- ===========================================================================

GRANT SELECT ON public.memory_garden_config TO authenticated;
GRANT SELECT ON public.memory_category_mapping TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_get_garden_progress() TO authenticated;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE public.memory_garden_config IS 'VTID-01086: Memory Garden category configuration with progress targets';
COMMENT ON TABLE public.memory_category_mapping IS 'VTID-01086: Maps memory_items categories to garden categories';
COMMENT ON FUNCTION public.memory_get_garden_progress IS 'VTID-01086: Returns memory counts and progress per garden category';
