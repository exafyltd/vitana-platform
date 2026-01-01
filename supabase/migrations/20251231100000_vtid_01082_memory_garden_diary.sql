-- Migration: 20251231100000_vtid_01082_memory_garden_diary.sql
-- Purpose: VTID-01082 Memory Garden Core + Daily Diary Ingestion (Phase D Foundation)
-- Date: 2025-12-31
--
-- Establishes Memory Garden as the canonical personal memory layer for:
-- - Deep personalization
-- - Community matching
-- - Longevity & health guidance
-- - Autopilot contextual intelligence
--
-- Core principles:
-- - User diary = source of truth
-- - No AI hallucination - only derive structured features from explicit user input
-- - Every entry is time-anchored
-- - Health & longevity framing by default
-- - Cross-domain reuse is read-only (no mutation outside Memory Garden)
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01102 (Phase B-Fix) - runtime context bridge
--   - VTID-01104 (Memory Core v1) - base memory tables

-- ===========================================================================
-- A. memory_diary_entries - User's daily diary entries (source of truth)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memory_diary_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    entry_date DATE NOT NULL,                    -- user-perceived date (not timestamp)
    entry_type TEXT NOT NULL CHECK (entry_type IN ('free', 'guided', 'health', 'reflection')),
    raw_text TEXT NOT NULL CHECK (raw_text != ''),
    mood TEXT NULL,                               -- optional mood descriptor
    energy_level INT NULL CHECK (energy_level IS NULL OR (energy_level >= 1 AND energy_level <= 10)),
    tags TEXT[] DEFAULT '{}',                     -- user-defined tags
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_diary_entries_tenant_user_date
    ON public.memory_diary_entries (tenant_id, user_id, entry_date DESC);

CREATE INDEX IF NOT EXISTS idx_diary_entries_tenant_user_created
    ON public.memory_diary_entries (tenant_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_diary_entries_entry_type
    ON public.memory_diary_entries (tenant_id, user_id, entry_type);

-- ===========================================================================
-- B. memory_garden_nodes - Semantic anchors (not chat logs)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memory_garden_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    domain TEXT NOT NULL CHECK (domain IN ('health', 'community', 'lifestyle', 'business', 'values')),
    source TEXT NOT NULL CHECK (source IN ('diary', 'import', 'system')),
    node_type TEXT NOT NULL CHECK (node_type IN ('habit', 'belief', 'goal', 'pattern', 'signal')),
    title TEXT NOT NULL CHECK (title != ''),
    summary TEXT NOT NULL CHECK (summary != ''),
    confidence INT NOT NULL DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 100),
    first_seen DATE NOT NULL DEFAULT CURRENT_DATE,
    last_seen DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_garden_nodes_tenant_user_domain
    ON public.memory_garden_nodes (tenant_id, user_id, domain);

CREATE INDEX IF NOT EXISTS idx_garden_nodes_tenant_user_type
    ON public.memory_garden_nodes (tenant_id, user_id, node_type);

CREATE INDEX IF NOT EXISTS idx_garden_nodes_tenant_user_last_seen
    ON public.memory_garden_nodes (tenant_id, user_id, last_seen DESC);

-- Unique constraint: prevent duplicate nodes (same user, domain, type, title)
CREATE UNIQUE INDEX IF NOT EXISTS idx_garden_nodes_unique_title
    ON public.memory_garden_nodes (tenant_id, user_id, domain, node_type, LOWER(title));

-- ===========================================================================
-- C. memory_node_sources - Links nodes to diary entries (provenance)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memory_node_sources (
    node_id UUID NOT NULL REFERENCES public.memory_garden_nodes(id) ON DELETE CASCADE,
    diary_entry_id UUID NOT NULL REFERENCES public.memory_diary_entries(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (node_id, diary_entry_id)
);

-- Index for efficient lookups by diary entry
CREATE INDEX IF NOT EXISTS idx_node_sources_diary_entry
    ON public.memory_node_sources (diary_entry_id);

-- ===========================================================================
-- RLS Policies - Enable Row Level Security
-- ===========================================================================

-- Enable RLS on all tables
ALTER TABLE public.memory_diary_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_garden_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_node_sources ENABLE ROW LEVEL SECURITY;

-- memory_diary_entries: Allow access only to own entries
DROP POLICY IF EXISTS diary_entries_select ON public.memory_diary_entries;
CREATE POLICY diary_entries_select ON public.memory_diary_entries
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS diary_entries_insert ON public.memory_diary_entries;
CREATE POLICY diary_entries_insert ON public.memory_diary_entries
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS diary_entries_update ON public.memory_diary_entries;
CREATE POLICY diary_entries_update ON public.memory_diary_entries
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS diary_entries_delete ON public.memory_diary_entries;
CREATE POLICY diary_entries_delete ON public.memory_diary_entries
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- memory_garden_nodes: Allow access only to own nodes
DROP POLICY IF EXISTS garden_nodes_select ON public.memory_garden_nodes;
CREATE POLICY garden_nodes_select ON public.memory_garden_nodes
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS garden_nodes_insert ON public.memory_garden_nodes;
CREATE POLICY garden_nodes_insert ON public.memory_garden_nodes
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS garden_nodes_update ON public.memory_garden_nodes;
CREATE POLICY garden_nodes_update ON public.memory_garden_nodes
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS garden_nodes_delete ON public.memory_garden_nodes;
CREATE POLICY garden_nodes_delete ON public.memory_garden_nodes
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- memory_node_sources: Allow access based on node ownership
DROP POLICY IF EXISTS node_sources_select ON public.memory_node_sources;
CREATE POLICY node_sources_select ON public.memory_node_sources
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.memory_garden_nodes n
            WHERE n.id = node_id
              AND n.tenant_id = public.current_tenant_id()
              AND n.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS node_sources_insert ON public.memory_node_sources;
CREATE POLICY node_sources_insert ON public.memory_node_sources
    FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.memory_garden_nodes n
            WHERE n.id = node_id
              AND n.tenant_id = public.current_tenant_id()
              AND n.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS node_sources_delete ON public.memory_node_sources;
CREATE POLICY node_sources_delete ON public.memory_node_sources
    FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.memory_garden_nodes n
            WHERE n.id = node_id
              AND n.tenant_id = public.current_tenant_id()
              AND n.user_id = auth.uid()
        )
    );

-- ===========================================================================
-- RPC: memory_add_diary_entry
-- Writes a diary entry, emits OASIS event (via gateway), NO derivation here
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_add_diary_entry(
    p_entry_date DATE,
    p_entry_type TEXT,
    p_raw_text TEXT,
    p_mood TEXT DEFAULT NULL,
    p_energy_level INT DEFAULT NULL,
    p_tags TEXT[] DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_active_role TEXT;
    v_new_id UUID;
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

    -- Derive active_role (for audit)
    v_active_role := public.current_active_role();

    -- Validate entry_date
    IF p_entry_date IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ENTRY_DATE',
            'message', 'entry_date is required'
        );
    END IF;

    -- Validate entry_type
    IF p_entry_type IS NULL OR p_entry_type NOT IN ('free', 'guided', 'health', 'reflection') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ENTRY_TYPE',
            'message', 'entry_type must be one of: free, guided, health, reflection'
        );
    END IF;

    -- Validate raw_text
    IF p_raw_text IS NULL OR p_raw_text = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_RAW_TEXT',
            'message', 'raw_text is required and cannot be empty'
        );
    END IF;

    -- Validate energy_level if provided
    IF p_energy_level IS NOT NULL AND (p_energy_level < 1 OR p_energy_level > 10) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ENERGY_LEVEL',
            'message', 'energy_level must be between 1 and 10'
        );
    END IF;

    -- Insert the diary entry
    INSERT INTO public.memory_diary_entries (
        tenant_id,
        user_id,
        entry_date,
        entry_type,
        raw_text,
        mood,
        energy_level,
        tags
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_entry_date,
        p_entry_type,
        p_raw_text,
        p_mood,
        p_energy_level,
        COALESCE(p_tags, '{}')
    )
    RETURNING id INTO v_new_id;

    -- Return success (OASIS event emitted by gateway)
    RETURN jsonb_build_object(
        'ok', true,
        'id', v_new_id,
        'entry_date', p_entry_date,
        'entry_type', p_entry_type,
        'tenant_id', v_tenant_id,
        'user_id', v_user_id,
        'active_role', v_active_role
    );
END;
$$;

-- ===========================================================================
-- RPC: memory_get_diary_entries
-- Retrieves diary entries for the current user within a date range
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_get_diary_entries(
    p_from DATE DEFAULT NULL,
    p_to DATE DEFAULT NULL,
    p_limit INT DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_entries JSONB;
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

    -- Cap limit to reasonable bounds
    IF p_limit IS NULL OR p_limit < 1 THEN
        p_limit := 50;
    ELSIF p_limit > 200 THEN
        p_limit := 200;
    END IF;

    -- Query diary entries with optional date range filter
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', de.id,
                'entry_date', de.entry_date,
                'entry_type', de.entry_type,
                'raw_text', de.raw_text,
                'mood', de.mood,
                'energy_level', de.energy_level,
                'tags', de.tags,
                'created_at', de.created_at,
                'updated_at', de.updated_at
            )
            ORDER BY de.entry_date DESC, de.created_at DESC
        ),
        '[]'::JSONB
    )
    INTO v_entries
    FROM public.memory_diary_entries de
    WHERE de.tenant_id = v_tenant_id
      AND de.user_id = v_user_id
      AND (p_from IS NULL OR de.entry_date >= p_from)
      AND (p_to IS NULL OR de.entry_date <= p_to)
    LIMIT p_limit;

    RETURN jsonb_build_object(
        'ok', true,
        'entries', v_entries,
        'count', jsonb_array_length(v_entries)
    );
END;
$$;

-- ===========================================================================
-- RPC: memory_extract_garden_nodes
-- Deterministic rule-based extraction (v1) from diary entry to garden nodes
-- Idempotent: same diary → same nodes
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_extract_garden_nodes(
    p_diary_entry_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_entry RECORD;
    v_text_lower TEXT;
    v_nodes_created INT := 0;
    v_nodes_updated INT := 0;
    v_node_id UUID;
    v_is_new BOOLEAN;
    v_extracted_nodes JSONB := '[]'::JSONB;
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

    -- Fetch the diary entry
    SELECT * INTO v_entry
    FROM public.memory_diary_entries
    WHERE id = p_diary_entry_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'DIARY_ENTRY_NOT_FOUND',
            'message', 'Diary entry not found or access denied'
        );
    END IF;

    v_text_lower := LOWER(v_entry.raw_text);

    -- =========================================================================
    -- RULE-BASED EXTRACTION (Deterministic v1)
    -- =========================================================================
    -- Rules detect:
    -- - recurring behaviors → 'habit' (domain: lifestyle/health)
    -- - health signals → 'signal' (domain: health)
    -- - intentions → 'goal' (domain: lifestyle/health/business)
    -- - values language → 'belief' (domain: values)
    -- - patterns → 'pattern' (domain: varies)
    -- =========================================================================

    -- HABIT detection: keywords indicating recurring behaviors
    IF v_text_lower ~ '(every day|daily|every morning|every night|routine|habit|always do|i (usually|always|regularly)|each (day|morning|evening))' THEN
        SELECT id, (id IS NULL) INTO v_node_id, v_is_new
        FROM memory_garden_node_upsert(
            v_tenant_id, v_user_id,
            'lifestyle', 'diary', 'habit',
            'Daily Routine',
            'User follows a recurring daily routine or habit',
            60, v_entry.entry_date
        );
        IF v_is_new THEN v_nodes_created := v_nodes_created + 1; ELSE v_nodes_updated := v_nodes_updated + 1; END IF;
        v_extracted_nodes := v_extracted_nodes || jsonb_build_object('node_id', v_node_id, 'type', 'habit', 'domain', 'lifestyle');
        -- Link to diary entry
        INSERT INTO public.memory_node_sources (node_id, diary_entry_id)
        VALUES (v_node_id, p_diary_entry_id) ON CONFLICT DO NOTHING;
    END IF;

    -- HEALTH SIGNAL detection: exercise, sleep, energy mentions
    IF v_text_lower ~ '(exercise|workout|run|jog|gym|lift|weights|yoga|stretch|walk|hike|swim)' THEN
        SELECT id, (id IS NULL) INTO v_node_id, v_is_new
        FROM memory_garden_node_upsert(
            v_tenant_id, v_user_id,
            'health', 'diary', 'signal',
            'Physical Activity',
            'User engages in physical exercise or movement',
            70, v_entry.entry_date
        );
        IF v_is_new THEN v_nodes_created := v_nodes_created + 1; ELSE v_nodes_updated := v_nodes_updated + 1; END IF;
        v_extracted_nodes := v_extracted_nodes || jsonb_build_object('node_id', v_node_id, 'type', 'signal', 'domain', 'health');
        INSERT INTO public.memory_node_sources (node_id, diary_entry_id)
        VALUES (v_node_id, p_diary_entry_id) ON CONFLICT DO NOTHING;
    END IF;

    IF v_text_lower ~ '(sleep|slept|insomnia|restless|tired|fatigue|exhausted|nap|rest)' THEN
        SELECT id, (id IS NULL) INTO v_node_id, v_is_new
        FROM memory_garden_node_upsert(
            v_tenant_id, v_user_id,
            'health', 'diary', 'signal',
            'Sleep Quality',
            'User mentions sleep-related patterns or concerns',
            65, v_entry.entry_date
        );
        IF v_is_new THEN v_nodes_created := v_nodes_created + 1; ELSE v_nodes_updated := v_nodes_updated + 1; END IF;
        v_extracted_nodes := v_extracted_nodes || jsonb_build_object('node_id', v_node_id, 'type', 'signal', 'domain', 'health');
        INSERT INTO public.memory_node_sources (node_id, diary_entry_id)
        VALUES (v_node_id, p_diary_entry_id) ON CONFLICT DO NOTHING;
    END IF;

    -- Energy level signal (from entry field)
    IF v_entry.energy_level IS NOT NULL THEN
        IF v_entry.energy_level >= 7 THEN
            SELECT id, (id IS NULL) INTO v_node_id, v_is_new
            FROM memory_garden_node_upsert(
                v_tenant_id, v_user_id,
                'health', 'diary', 'signal',
                'High Energy Days',
                'User reports high energy levels',
                50 + (v_entry.energy_level * 5), v_entry.entry_date
            );
        ELSIF v_entry.energy_level <= 3 THEN
            SELECT id, (id IS NULL) INTO v_node_id, v_is_new
            FROM memory_garden_node_upsert(
                v_tenant_id, v_user_id,
                'health', 'diary', 'signal',
                'Low Energy Days',
                'User reports low energy levels',
                50 + ((10 - v_entry.energy_level) * 3), v_entry.entry_date
            );
        ELSE
            v_node_id := NULL;
        END IF;
        IF v_node_id IS NOT NULL THEN
            IF v_is_new THEN v_nodes_created := v_nodes_created + 1; ELSE v_nodes_updated := v_nodes_updated + 1; END IF;
            v_extracted_nodes := v_extracted_nodes || jsonb_build_object('node_id', v_node_id, 'type', 'signal', 'domain', 'health');
            INSERT INTO public.memory_node_sources (node_id, diary_entry_id)
            VALUES (v_node_id, p_diary_entry_id) ON CONFLICT DO NOTHING;
        END IF;
    END IF;

    -- GOAL detection: intention language
    IF v_text_lower ~ '(want to|going to|will start|need to|plan to|hope to|intend to|goal is|my goal|aiming for|working towards)' THEN
        SELECT id, (id IS NULL) INTO v_node_id, v_is_new
        FROM memory_garden_node_upsert(
            v_tenant_id, v_user_id,
            'lifestyle', 'diary', 'goal',
            'Personal Goals',
            'User expresses intentions or goals for the future',
            55, v_entry.entry_date
        );
        IF v_is_new THEN v_nodes_created := v_nodes_created + 1; ELSE v_nodes_updated := v_nodes_updated + 1; END IF;
        v_extracted_nodes := v_extracted_nodes || jsonb_build_object('node_id', v_node_id, 'type', 'goal', 'domain', 'lifestyle');
        INSERT INTO public.memory_node_sources (node_id, diary_entry_id)
        VALUES (v_node_id, p_diary_entry_id) ON CONFLICT DO NOTHING;
    END IF;

    -- BELIEF/VALUES detection: values language
    IF v_text_lower ~ '(believe|important to me|value|principle|matters most|core belief|i (think|feel) that|what matters|my philosophy)' THEN
        SELECT id, (id IS NULL) INTO v_node_id, v_is_new
        FROM memory_garden_node_upsert(
            v_tenant_id, v_user_id,
            'values', 'diary', 'belief',
            'Core Values',
            'User expresses personal beliefs or values',
            60, v_entry.entry_date
        );
        IF v_is_new THEN v_nodes_created := v_nodes_created + 1; ELSE v_nodes_updated := v_nodes_updated + 1; END IF;
        v_extracted_nodes := v_extracted_nodes || jsonb_build_object('node_id', v_node_id, 'type', 'belief', 'domain', 'values');
        INSERT INTO public.memory_node_sources (node_id, diary_entry_id)
        VALUES (v_node_id, p_diary_entry_id) ON CONFLICT DO NOTHING;
    END IF;

    -- COMMUNITY detection: social connections
    IF v_text_lower ~ '(friend|family|colleague|community|group|meet|gathering|social|together with|spent time with)' THEN
        SELECT id, (id IS NULL) INTO v_node_id, v_is_new
        FROM memory_garden_node_upsert(
            v_tenant_id, v_user_id,
            'community', 'diary', 'pattern',
            'Social Connections',
            'User mentions social interactions and relationships',
            50, v_entry.entry_date
        );
        IF v_is_new THEN v_nodes_created := v_nodes_created + 1; ELSE v_nodes_updated := v_nodes_updated + 1; END IF;
        v_extracted_nodes := v_extracted_nodes || jsonb_build_object('node_id', v_node_id, 'type', 'pattern', 'domain', 'community');
        INSERT INTO public.memory_node_sources (node_id, diary_entry_id)
        VALUES (v_node_id, p_diary_entry_id) ON CONFLICT DO NOTHING;
    END IF;

    -- NUTRITION detection: diet-related mentions
    IF v_text_lower ~ '(eat|ate|food|meal|breakfast|lunch|dinner|snack|diet|nutrition|vegetable|fruit|protein|carb|calorie|fasting)' THEN
        SELECT id, (id IS NULL) INTO v_node_id, v_is_new
        FROM memory_garden_node_upsert(
            v_tenant_id, v_user_id,
            'health', 'diary', 'signal',
            'Nutrition Tracking',
            'User mentions dietary habits or food consumption',
            55, v_entry.entry_date
        );
        IF v_is_new THEN v_nodes_created := v_nodes_created + 1; ELSE v_nodes_updated := v_nodes_updated + 1; END IF;
        v_extracted_nodes := v_extracted_nodes || jsonb_build_object('node_id', v_node_id, 'type', 'signal', 'domain', 'health');
        INSERT INTO public.memory_node_sources (node_id, diary_entry_id)
        VALUES (v_node_id, p_diary_entry_id) ON CONFLICT DO NOTHING;
    END IF;

    -- MOOD pattern: from mood field
    IF v_entry.mood IS NOT NULL AND v_entry.mood != '' THEN
        SELECT id, (id IS NULL) INTO v_node_id, v_is_new
        FROM memory_garden_node_upsert(
            v_tenant_id, v_user_id,
            'health', 'diary', 'signal',
            'Mood Tracking',
            'User tracks emotional states and moods',
            60, v_entry.entry_date
        );
        IF v_is_new THEN v_nodes_created := v_nodes_created + 1; ELSE v_nodes_updated := v_nodes_updated + 1; END IF;
        v_extracted_nodes := v_extracted_nodes || jsonb_build_object('node_id', v_node_id, 'type', 'signal', 'domain', 'health', 'mood', v_entry.mood);
        INSERT INTO public.memory_node_sources (node_id, diary_entry_id)
        VALUES (v_node_id, p_diary_entry_id) ON CONFLICT DO NOTHING;
    END IF;

    -- BUSINESS detection: work-related mentions
    IF v_text_lower ~ '(work|job|career|business|meeting|project|client|deadline|office|professional|startup|company)' THEN
        SELECT id, (id IS NULL) INTO v_node_id, v_is_new
        FROM memory_garden_node_upsert(
            v_tenant_id, v_user_id,
            'business', 'diary', 'pattern',
            'Work & Career',
            'User mentions work-related activities or thoughts',
            50, v_entry.entry_date
        );
        IF v_is_new THEN v_nodes_created := v_nodes_created + 1; ELSE v_nodes_updated := v_nodes_updated + 1; END IF;
        v_extracted_nodes := v_extracted_nodes || jsonb_build_object('node_id', v_node_id, 'type', 'pattern', 'domain', 'business');
        INSERT INTO public.memory_node_sources (node_id, diary_entry_id)
        VALUES (v_node_id, p_diary_entry_id) ON CONFLICT DO NOTHING;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'diary_entry_id', p_diary_entry_id,
        'nodes_created', v_nodes_created,
        'nodes_updated', v_nodes_updated,
        'extracted_nodes', v_extracted_nodes
    );
END;
$$;

-- ===========================================================================
-- Helper: memory_garden_node_upsert
-- Upserts a garden node (creates or updates last_seen), returns node_id and is_new
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_garden_node_upsert(
    p_tenant_id UUID,
    p_user_id UUID,
    p_domain TEXT,
    p_source TEXT,
    p_node_type TEXT,
    p_title TEXT,
    p_summary TEXT,
    p_confidence INT,
    p_seen_date DATE
)
RETURNS TABLE(id UUID, is_new BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_existing_id UUID;
    v_new_id UUID;
BEGIN
    -- Try to find existing node with same title (case-insensitive)
    SELECT n.id INTO v_existing_id
    FROM public.memory_garden_nodes n
    WHERE n.tenant_id = p_tenant_id
      AND n.user_id = p_user_id
      AND n.domain = p_domain
      AND n.node_type = p_node_type
      AND LOWER(n.title) = LOWER(p_title);

    IF v_existing_id IS NOT NULL THEN
        -- Update last_seen and potentially increase confidence
        UPDATE public.memory_garden_nodes
        SET last_seen = GREATEST(last_seen, p_seen_date),
            confidence = LEAST(100, confidence + 5)
        WHERE memory_garden_nodes.id = v_existing_id;

        RETURN QUERY SELECT v_existing_id, false;
    ELSE
        -- Create new node
        INSERT INTO public.memory_garden_nodes (
            tenant_id, user_id, domain, source, node_type, title, summary, confidence, first_seen, last_seen
        ) VALUES (
            p_tenant_id, p_user_id, p_domain, p_source, p_node_type, p_title, p_summary, p_confidence, p_seen_date, p_seen_date
        )
        RETURNING memory_garden_nodes.id INTO v_new_id;

        RETURN QUERY SELECT v_new_id, true;
    END IF;
END;
$$;

-- ===========================================================================
-- RPC: memory_get_garden_summary
-- Returns aggregated garden summary for cross-domain consumers
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_get_garden_summary()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_habits JSONB;
    v_health_signals JSONB;
    v_values JSONB;
    v_goals JSONB;
    v_patterns JSONB;
    v_avg_confidence NUMERIC;
    v_last_updated TIMESTAMPTZ;
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

    -- Fetch habits
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', n.id,
            'title', n.title,
            'summary', n.summary,
            'domain', n.domain,
            'confidence', n.confidence,
            'first_seen', n.first_seen,
            'last_seen', n.last_seen
        ) ORDER BY n.confidence DESC, n.last_seen DESC
    ), '[]'::JSONB)
    INTO v_habits
    FROM public.memory_garden_nodes n
    WHERE n.tenant_id = v_tenant_id
      AND n.user_id = v_user_id
      AND n.node_type = 'habit';

    -- Fetch health signals
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', n.id,
            'title', n.title,
            'summary', n.summary,
            'confidence', n.confidence,
            'first_seen', n.first_seen,
            'last_seen', n.last_seen
        ) ORDER BY n.confidence DESC, n.last_seen DESC
    ), '[]'::JSONB)
    INTO v_health_signals
    FROM public.memory_garden_nodes n
    WHERE n.tenant_id = v_tenant_id
      AND n.user_id = v_user_id
      AND n.domain = 'health'
      AND n.node_type = 'signal';

    -- Fetch values/beliefs
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', n.id,
            'title', n.title,
            'summary', n.summary,
            'confidence', n.confidence,
            'first_seen', n.first_seen,
            'last_seen', n.last_seen
        ) ORDER BY n.confidence DESC, n.last_seen DESC
    ), '[]'::JSONB)
    INTO v_values
    FROM public.memory_garden_nodes n
    WHERE n.tenant_id = v_tenant_id
      AND n.user_id = v_user_id
      AND n.node_type = 'belief';

    -- Fetch goals
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', n.id,
            'title', n.title,
            'summary', n.summary,
            'domain', n.domain,
            'confidence', n.confidence,
            'first_seen', n.first_seen,
            'last_seen', n.last_seen
        ) ORDER BY n.confidence DESC, n.last_seen DESC
    ), '[]'::JSONB)
    INTO v_goals
    FROM public.memory_garden_nodes n
    WHERE n.tenant_id = v_tenant_id
      AND n.user_id = v_user_id
      AND n.node_type = 'goal';

    -- Fetch patterns
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', n.id,
            'title', n.title,
            'summary', n.summary,
            'domain', n.domain,
            'confidence', n.confidence,
            'first_seen', n.first_seen,
            'last_seen', n.last_seen
        ) ORDER BY n.confidence DESC, n.last_seen DESC
    ), '[]'::JSONB)
    INTO v_patterns
    FROM public.memory_garden_nodes n
    WHERE n.tenant_id = v_tenant_id
      AND n.user_id = v_user_id
      AND n.node_type = 'pattern';

    -- Calculate average confidence
    SELECT COALESCE(AVG(n.confidence), 0)
    INTO v_avg_confidence
    FROM public.memory_garden_nodes n
    WHERE n.tenant_id = v_tenant_id
      AND n.user_id = v_user_id;

    -- Get last updated timestamp
    SELECT MAX(n.created_at)
    INTO v_last_updated
    FROM public.memory_garden_nodes n
    WHERE n.tenant_id = v_tenant_id
      AND n.user_id = v_user_id;

    RETURN jsonb_build_object(
        'ok', true,
        'habits', v_habits,
        'health_signals', v_health_signals,
        'values', v_values,
        'goals', v_goals,
        'patterns', v_patterns,
        'confidence_score', ROUND(v_avg_confidence),
        'last_updated', COALESCE(v_last_updated, NOW())
    );
END;
$$;

-- ===========================================================================
-- Permissions
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.memory_add_diary_entry(DATE, TEXT, TEXT, TEXT, INT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_get_diary_entries(DATE, DATE, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_extract_garden_nodes(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_garden_node_upsert(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_get_garden_summary() TO authenticated;

-- Tables: allow authenticated users to interact (RLS will enforce row-level access)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_diary_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_garden_nodes TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.memory_node_sources TO authenticated;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE public.memory_diary_entries IS 'VTID-01082: Daily diary entries - source of truth for user memory';
COMMENT ON TABLE public.memory_garden_nodes IS 'VTID-01082: Semantic memory anchors derived from diary entries';
COMMENT ON TABLE public.memory_node_sources IS 'VTID-01082: Links garden nodes to their source diary entries';
COMMENT ON FUNCTION public.memory_add_diary_entry IS 'VTID-01082: Add a diary entry for the current user';
COMMENT ON FUNCTION public.memory_get_diary_entries IS 'VTID-01082: Retrieve diary entries for the current user with optional date range';
COMMENT ON FUNCTION public.memory_extract_garden_nodes IS 'VTID-01082: Deterministic extraction of garden nodes from a diary entry';
COMMENT ON FUNCTION public.memory_garden_node_upsert IS 'VTID-01082: Helper to upsert garden nodes (create or update last_seen)';
COMMENT ON FUNCTION public.memory_get_garden_summary IS 'VTID-01082: Get aggregated garden summary for cross-domain consumers';
