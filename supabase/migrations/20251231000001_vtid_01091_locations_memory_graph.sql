-- Migration: 20251231000001_vtid_01091_locations_memory_graph.sql
-- Purpose: VTID-01091 Locations Memory (Places + Habits + Meetups) + Longevity Discovery
-- Date: 2025-12-31
--
-- Creates:
--   1. locations - First-class location memory table
--   2. location_visits - Explicit check-ins and visit records
--   3. location_preferences - User location privacy/sharing settings
--   4. relationship_edges - Generic relationship graph (supports person->location, location->meetup, etc.)
--   5. RPC functions: location_add, location_checkin, location_nearby_discovery
--   6. Relationship edge strengthening logic
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01102 (Phase B-Fix) - runtime context bridge
--   - VTID-01104 (Memory Core v1) - memory_items table
--
-- Privacy Model:
--   - private: only visible to owner
--   - shared: visible to meetup attendees at that location
--   - public: visible in discovery (with consent)

-- ===========================================================================
-- 1. LOCATIONS TABLE - First-class location memory
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    created_by UUID NOT NULL,  -- user who created this location
    name TEXT NOT NULL CHECK (name != ''),
    location_type TEXT NOT NULL CHECK (location_type IN (
        'park', 'gym', 'clinic', 'cafe', 'store', 'home', 'work', 'other'
    )),
    country TEXT NULL,
    city TEXT NULL,
    area TEXT NULL,  -- neighborhood/district
    lat DOUBLE PRECISION NULL,
    lng DOUBLE PRECISION NULL,
    privacy_level TEXT NOT NULL DEFAULT 'private' CHECK (privacy_level IN (
        'private', 'shared', 'public'
    )),
    topic_keys TEXT[] NOT NULL DEFAULT '{}',  -- e.g. ['walking','strength','recovery']
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for location queries
CREATE INDEX IF NOT EXISTS idx_locations_tenant_created_by
    ON public.locations (tenant_id, created_by);

CREATE INDEX IF NOT EXISTS idx_locations_tenant_city
    ON public.locations (tenant_id, city) WHERE city IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_locations_tenant_type
    ON public.locations (tenant_id, location_type);

CREATE INDEX IF NOT EXISTS idx_locations_tenant_privacy
    ON public.locations (tenant_id, privacy_level);

-- GIN index for topic_keys array matching
CREATE INDEX IF NOT EXISTS idx_locations_topic_keys
    ON public.locations USING GIN (topic_keys);

-- Spatial index placeholder (for future PostGIS integration)
-- CREATE INDEX IF NOT EXISTS idx_locations_geo ON public.locations USING GIST (geography(ST_SetSRID(ST_Point(lng, lat), 4326)));

-- ===========================================================================
-- 2. LOCATION_VISITS TABLE - Explicit check-ins only
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.location_visits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    visit_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    visit_type TEXT NOT NULL CHECK (visit_type IN (
        'checkin', 'meetup', 'service', 'diary_mention'
    )),
    notes TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',  -- Can include meetup_id, service_id, etc.
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Prevent duplicate check-ins at same time
    CONSTRAINT unique_visit UNIQUE (tenant_id, user_id, location_id, visit_time)
);

-- Indexes for visit queries
CREATE INDEX IF NOT EXISTS idx_location_visits_tenant_user_time
    ON public.location_visits (tenant_id, user_id, visit_time DESC);

CREATE INDEX IF NOT EXISTS idx_location_visits_tenant_location_time
    ON public.location_visits (tenant_id, location_id, visit_time DESC);

CREATE INDEX IF NOT EXISTS idx_location_visits_type
    ON public.location_visits (visit_type);

-- ===========================================================================
-- 3. LOCATION_PREFERENCES TABLE - User privacy & sharing settings
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.location_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    preferred_radius_km INT NOT NULL DEFAULT 10,
    allow_location_personalization BOOLEAN NOT NULL DEFAULT true,
    allow_sharing_in_meetups BOOLEAN NOT NULL DEFAULT false,
    home_city TEXT NULL,
    home_area TEXT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_user_prefs UNIQUE (tenant_id, user_id)
);

-- ===========================================================================
-- 4. RELATIONSHIP_EDGES TABLE - Generic relationship graph (VTID-01087 foundation)
-- ===========================================================================
-- Supports edge types: visited, hosted_at, attendee, friend, etc.
-- Each edge has strength (0-100) that can be strengthened over time

CREATE TABLE IF NOT EXISTS public.relationship_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN (
        'person', 'location', 'meetup', 'product', 'service', 'habit'
    )),
    source_id UUID NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN (
        'person', 'location', 'meetup', 'product', 'service', 'habit'
    )),
    target_id UUID NOT NULL,
    edge_type TEXT NOT NULL CHECK (edge_type IN (
        'visited', 'hosted_at', 'attendee', 'friend', 'follows', 'uses', 'owns', 'linked_habit'
    )),
    strength INT NOT NULL DEFAULT 0 CHECK (strength >= 0 AND strength <= 100),
    last_interaction TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Each source->target->edge_type combination is unique within a tenant
    CONSTRAINT unique_edge UNIQUE (tenant_id, source_type, source_id, target_type, target_id, edge_type)
);

-- Indexes for edge queries
CREATE INDEX IF NOT EXISTS idx_relationship_edges_source
    ON public.relationship_edges (tenant_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_relationship_edges_target
    ON public.relationship_edges (tenant_id, target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_relationship_edges_type
    ON public.relationship_edges (edge_type);

CREATE INDEX IF NOT EXISTS idx_relationship_edges_strength
    ON public.relationship_edges (strength DESC);

-- ===========================================================================
-- 5. RLS POLICIES
-- ===========================================================================

-- Enable RLS on all new tables
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relationship_edges ENABLE ROW LEVEL SECURITY;

-- LOCATIONS RLS: Users can see their own + public + shared (if they have a visit)
DROP POLICY IF EXISTS locations_select ON public.locations;
CREATE POLICY locations_select ON public.locations
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND (
            -- Own locations
            created_by = auth.uid()
            -- Public locations
            OR privacy_level = 'public'
            -- Shared locations where user has visited
            OR (privacy_level = 'shared' AND EXISTS (
                SELECT 1 FROM public.location_visits lv
                WHERE lv.location_id = locations.id
                  AND lv.user_id = auth.uid()
                  AND lv.tenant_id = public.current_tenant_id()
            ))
        )
    );

DROP POLICY IF EXISTS locations_insert ON public.locations;
CREATE POLICY locations_insert ON public.locations
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND created_by = auth.uid()
    );

DROP POLICY IF EXISTS locations_update ON public.locations;
CREATE POLICY locations_update ON public.locations
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND created_by = auth.uid()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND created_by = auth.uid()
    );

DROP POLICY IF EXISTS locations_delete ON public.locations;
CREATE POLICY locations_delete ON public.locations
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND created_by = auth.uid()
    );

-- LOCATION_VISITS RLS: Users can only see their own visits
DROP POLICY IF EXISTS location_visits_select ON public.location_visits;
CREATE POLICY location_visits_select ON public.location_visits
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS location_visits_insert ON public.location_visits;
CREATE POLICY location_visits_insert ON public.location_visits
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS location_visits_update ON public.location_visits;
CREATE POLICY location_visits_update ON public.location_visits
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

DROP POLICY IF EXISTS location_visits_delete ON public.location_visits;
CREATE POLICY location_visits_delete ON public.location_visits
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- LOCATION_PREFERENCES RLS: Users can only access their own preferences
DROP POLICY IF EXISTS location_preferences_select ON public.location_preferences;
CREATE POLICY location_preferences_select ON public.location_preferences
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS location_preferences_insert ON public.location_preferences;
CREATE POLICY location_preferences_insert ON public.location_preferences
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS location_preferences_update ON public.location_preferences;
CREATE POLICY location_preferences_update ON public.location_preferences
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

-- RELATIONSHIP_EDGES RLS: Users can see edges where they are the source (person type)
DROP POLICY IF EXISTS relationship_edges_select ON public.relationship_edges;
CREATE POLICY relationship_edges_select ON public.relationship_edges
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND (
            -- User's own edges (where they are the source person)
            (source_type = 'person' AND source_id = auth.uid())
            -- Edges targeting user
            OR (target_type = 'person' AND target_id = auth.uid())
        )
    );

DROP POLICY IF EXISTS relationship_edges_insert ON public.relationship_edges;
CREATE POLICY relationship_edges_insert ON public.relationship_edges
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND source_type = 'person'
        AND source_id = auth.uid()
    );

DROP POLICY IF EXISTS relationship_edges_update ON public.relationship_edges;
CREATE POLICY relationship_edges_update ON public.relationship_edges
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND source_type = 'person'
        AND source_id = auth.uid()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND source_type = 'person'
        AND source_id = auth.uid()
    );

-- ===========================================================================
-- 6. RPC FUNCTION: location_add
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.location_add(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_name TEXT;
    v_location_type TEXT;
    v_country TEXT;
    v_city TEXT;
    v_area TEXT;
    v_lat DOUBLE PRECISION;
    v_lng DOUBLE PRECISION;
    v_privacy_level TEXT;
    v_topic_keys TEXT[];
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

    -- Extract required fields
    v_name := p_payload->>'name';
    v_location_type := COALESCE(p_payload->>'location_type', 'other');

    -- Validate required fields
    IF v_name IS NULL OR v_name = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_NAME',
            'message', 'name is required and cannot be empty'
        );
    END IF;

    -- Validate location_type
    IF v_location_type NOT IN ('park', 'gym', 'clinic', 'cafe', 'store', 'home', 'work', 'other') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_LOCATION_TYPE',
            'message', 'location_type must be one of: park, gym, clinic, cafe, store, home, work, other'
        );
    END IF;

    -- Extract optional fields
    v_country := p_payload->>'country';
    v_city := p_payload->>'city';
    v_area := p_payload->>'area';
    v_lat := (p_payload->>'lat')::DOUBLE PRECISION;
    v_lng := (p_payload->>'lng')::DOUBLE PRECISION;
    v_privacy_level := COALESCE(p_payload->>'privacy_level', 'private');

    -- Parse topic_keys from JSON array
    IF p_payload ? 'topic_keys' AND p_payload->'topic_keys' IS NOT NULL THEN
        SELECT ARRAY(SELECT jsonb_array_elements_text(p_payload->'topic_keys'))
        INTO v_topic_keys;
    ELSE
        v_topic_keys := '{}';
    END IF;

    -- Validate privacy_level
    IF v_privacy_level NOT IN ('private', 'shared', 'public') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_PRIVACY_LEVEL',
            'message', 'privacy_level must be one of: private, shared, public'
        );
    END IF;

    -- Check for duplicate location (same name, same user)
    IF EXISTS (
        SELECT 1 FROM public.locations
        WHERE tenant_id = v_tenant_id
          AND created_by = v_user_id
          AND LOWER(name) = LOWER(v_name)
    ) THEN
        -- Return existing location instead of error
        SELECT id INTO v_new_id
        FROM public.locations
        WHERE tenant_id = v_tenant_id
          AND created_by = v_user_id
          AND LOWER(name) = LOWER(v_name)
        LIMIT 1;

        RETURN jsonb_build_object(
            'ok', true,
            'id', v_new_id,
            'reused', true,
            'message', 'Existing location found with same name'
        );
    END IF;

    -- Insert the location
    INSERT INTO public.locations (
        tenant_id,
        created_by,
        name,
        location_type,
        country,
        city,
        area,
        lat,
        lng,
        privacy_level,
        topic_keys
    ) VALUES (
        v_tenant_id,
        v_user_id,
        v_name,
        v_location_type,
        v_country,
        v_city,
        v_area,
        v_lat,
        v_lng,
        v_privacy_level,
        v_topic_keys
    )
    RETURNING id INTO v_new_id;

    -- Return success
    RETURN jsonb_build_object(
        'ok', true,
        'id', v_new_id,
        'name', v_name,
        'location_type', v_location_type,
        'privacy_level', v_privacy_level,
        'reused', false
    );
END;
$$;

-- ===========================================================================
-- 7. RPC FUNCTION: location_checkin
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.location_checkin(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_location_id UUID;
    v_visit_time TIMESTAMPTZ;
    v_visit_type TEXT;
    v_notes TEXT;
    v_visit_id UUID;
    v_edge_id UUID;
    v_current_strength INT;
    v_new_strength INT;
    v_visits_today INT;
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

    -- Extract required fields
    v_location_id := (p_payload->>'location_id')::UUID;
    IF v_location_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_LOCATION_ID',
            'message', 'location_id is required'
        );
    END IF;

    -- Validate location exists and user has access
    IF NOT EXISTS (
        SELECT 1 FROM public.locations
        WHERE id = v_location_id
          AND tenant_id = v_tenant_id
          AND (
              created_by = v_user_id
              OR privacy_level IN ('shared', 'public')
          )
    ) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'LOCATION_NOT_FOUND',
            'message', 'Location not found or access denied'
        );
    END IF;

    -- Extract optional fields
    v_visit_time := COALESCE((p_payload->>'visit_time')::TIMESTAMPTZ, NOW());
    v_visit_type := COALESCE(p_payload->>'visit_type', 'checkin');
    v_notes := p_payload->>'notes';

    -- Validate visit_type
    IF v_visit_type NOT IN ('checkin', 'meetup', 'service', 'diary_mention') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_VISIT_TYPE',
            'message', 'visit_type must be one of: checkin, meetup, service, diary_mention'
        );
    END IF;

    -- Insert the visit (ON CONFLICT to handle duplicates)
    INSERT INTO public.location_visits (
        tenant_id,
        user_id,
        location_id,
        visit_time,
        visit_type,
        notes,
        metadata
    ) VALUES (
        v_tenant_id,
        v_user_id,
        v_location_id,
        v_visit_time,
        v_visit_type,
        v_notes,
        COALESCE(p_payload->'metadata', '{}'::JSONB)
    )
    ON CONFLICT (tenant_id, user_id, location_id, visit_time) DO UPDATE
    SET notes = EXCLUDED.notes,
        metadata = EXCLUDED.metadata
    RETURNING id INTO v_visit_id;

    -- =========================================================================
    -- Relationship Edge Strengthening (VTID-01087 integration)
    -- =========================================================================

    -- Calculate strength increment based on visit_type
    -- checkin: +10, meetup: +5, service: +5, diary_mention: +3
    v_new_strength := CASE v_visit_type
        WHEN 'checkin' THEN 10
        WHEN 'meetup' THEN 5
        WHEN 'service' THEN 5
        WHEN 'diary_mention' THEN 3
        ELSE 5
    END;

    -- Check visits today for repeated visits cap (30/day)
    SELECT COUNT(*) INTO v_visits_today
    FROM public.location_visits
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND location_id = v_location_id
      AND visit_time::DATE = v_visit_time::DATE;

    -- Cap repeated visits strength to 30/day
    IF v_visits_today > 1 THEN
        -- Additional visits within 30 days: +3 each (capped)
        v_new_strength := LEAST(3, 30 - LEAST(30, (v_visits_today - 1) * 3));
        IF v_new_strength < 0 THEN
            v_new_strength := 0;
        END IF;
    END IF;

    -- Upsert the person->location 'visited' edge
    INSERT INTO public.relationship_edges (
        tenant_id,
        source_type,
        source_id,
        target_type,
        target_id,
        edge_type,
        strength,
        last_interaction,
        metadata
    ) VALUES (
        v_tenant_id,
        'person',
        v_user_id,
        'location',
        v_location_id,
        'visited',
        LEAST(100, v_new_strength),
        v_visit_time,
        jsonb_build_object('visit_type', v_visit_type, 'visit_id', v_visit_id)
    )
    ON CONFLICT (tenant_id, source_type, source_id, target_type, target_id, edge_type)
    DO UPDATE SET
        strength = LEAST(100, relationship_edges.strength + v_new_strength),
        last_interaction = v_visit_time,
        metadata = relationship_edges.metadata ||
            jsonb_build_object('last_visit_type', v_visit_type, 'last_visit_id', v_visit_id)
    RETURNING id, strength INTO v_edge_id, v_current_strength;

    -- Return success
    RETURN jsonb_build_object(
        'ok', true,
        'visit_id', v_visit_id,
        'location_id', v_location_id,
        'visit_time', v_visit_time,
        'visit_type', v_visit_type,
        'edge_strengthened', true,
        'edge_id', v_edge_id,
        'edge_strength', v_current_strength
    );
END;
$$;

-- ===========================================================================
-- 8. RPC FUNCTION: location_nearby_discovery
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.location_nearby_discovery(
    p_lat DOUBLE PRECISION DEFAULT NULL,
    p_lng DOUBLE PRECISION DEFAULT NULL,
    p_radius_km INT DEFAULT 10,
    p_topic_keys TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_user_prefs RECORD;
    v_user_city TEXT;
    v_user_area TEXT;
    v_locations JSONB;
    v_meetups JSONB;
    v_frequent_locations JSONB;
    v_radius_km INT;
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

    -- Get user preferences for radius and home location
    SELECT * INTO v_user_prefs
    FROM public.location_preferences
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    v_radius_km := COALESCE(p_radius_km, v_user_prefs.preferred_radius_km, 10);
    v_user_city := v_user_prefs.home_city;
    v_user_area := v_user_prefs.home_area;

    -- =========================================================================
    -- Discovery Logic (Longevity-first prioritization)
    -- =========================================================================

    -- 1. Find public/shared locations matching criteria
    IF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
        -- Haversine distance calculation (approximate for small distances)
        -- 111.32 km per degree latitude, 111.32 * cos(lat) per degree longitude
        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', l.id,
                    'name', l.name,
                    'location_type', l.location_type,
                    'city', l.city,
                    'area', l.area,
                    'lat', l.lat,
                    'lng', l.lng,
                    'topic_keys', l.topic_keys,
                    'distance_km', ROUND((
                        111.32 * SQRT(
                            POWER(l.lat - p_lat, 2) +
                            POWER((l.lng - p_lng) * COS(RADIANS(p_lat)), 2)
                        )
                    )::NUMERIC, 2),
                    'why', jsonb_build_array(
                        CASE
                            WHEN p_topic_keys IS NOT NULL AND l.topic_keys && p_topic_keys
                            THEN jsonb_build_object('reason', 'topic_match', 'matched_topics',
                                (SELECT jsonb_agg(t) FROM unnest(l.topic_keys) t WHERE t = ANY(p_topic_keys)))
                            ELSE NULL
                        END,
                        jsonb_build_object('reason', 'nearby', 'distance_km', ROUND((
                            111.32 * SQRT(
                                POWER(l.lat - p_lat, 2) +
                                POWER((l.lng - p_lng) * COS(RADIANS(p_lat)), 2)
                            )
                        )::NUMERIC, 2))
                    )
                )
                ORDER BY (
                    -- Prioritize: topic match > distance
                    CASE WHEN p_topic_keys IS NOT NULL AND l.topic_keys && p_topic_keys THEN 0 ELSE 1 END,
                    111.32 * SQRT(
                        POWER(l.lat - p_lat, 2) +
                        POWER((l.lng - p_lng) * COS(RADIANS(p_lat)), 2)
                    )
                )
            ),
            '[]'::JSONB
        )
        INTO v_locations
        FROM public.locations l
        WHERE l.tenant_id = v_tenant_id
          AND l.privacy_level = 'public'
          AND l.lat IS NOT NULL
          AND l.lng IS NOT NULL
          AND (
              -- Within radius (approximate Haversine)
              111.32 * SQRT(
                  POWER(l.lat - p_lat, 2) +
                  POWER((l.lng - p_lng) * COS(RADIANS(p_lat)), 2)
              ) <= v_radius_km
          )
          AND (
              p_topic_keys IS NULL
              OR l.topic_keys && p_topic_keys
          )
        LIMIT 20;
    ELSE
        -- Fallback to city/area match only
        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', l.id,
                    'name', l.name,
                    'location_type', l.location_type,
                    'city', l.city,
                    'area', l.area,
                    'topic_keys', l.topic_keys,
                    'why', jsonb_build_array(
                        CASE
                            WHEN p_topic_keys IS NOT NULL AND l.topic_keys && p_topic_keys
                            THEN jsonb_build_object('reason', 'topic_match', 'matched_topics',
                                (SELECT jsonb_agg(t) FROM unnest(l.topic_keys) t WHERE t = ANY(p_topic_keys)))
                            ELSE NULL
                        END,
                        jsonb_build_object('reason', 'city_match', 'city', l.city)
                    )
                )
            ),
            '[]'::JSONB
        )
        INTO v_locations
        FROM public.locations l
        WHERE l.tenant_id = v_tenant_id
          AND l.privacy_level = 'public'
          AND (
              l.city = v_user_city
              OR l.area = v_user_area
          )
          AND (
              p_topic_keys IS NULL
              OR l.topic_keys && p_topic_keys
          )
        LIMIT 20;
    END IF;

    -- 2. Find user's frequently visited locations that match topic_keys
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', l.id,
                'name', l.name,
                'location_type', l.location_type,
                'city', l.city,
                'area', l.area,
                'topic_keys', l.topic_keys,
                'visit_count', visit_counts.visit_count,
                'edge_strength', COALESCE(edge_info.strength, 0),
                'why', jsonb_build_array(
                    jsonb_build_object('reason', 'frequent_visits', 'visit_count', visit_counts.visit_count),
                    CASE
                        WHEN p_topic_keys IS NOT NULL AND l.topic_keys && p_topic_keys
                        THEN jsonb_build_object('reason', 'topic_match', 'matched_topics',
                            (SELECT jsonb_agg(t) FROM unnest(l.topic_keys) t WHERE t = ANY(p_topic_keys)))
                        ELSE NULL
                    END,
                    CASE
                        WHEN COALESCE(edge_info.strength, 0) > 50
                        THEN jsonb_build_object('reason', 'strong_relationship', 'strength', edge_info.strength)
                        ELSE NULL
                    END
                )
            )
            ORDER BY visit_counts.visit_count DESC, edge_info.strength DESC NULLS LAST
        ),
        '[]'::JSONB
    )
    INTO v_frequent_locations
    FROM public.locations l
    INNER JOIN (
        SELECT location_id, COUNT(*) as visit_count
        FROM public.location_visits
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND visit_time >= NOW() - INTERVAL '30 days'
        GROUP BY location_id
        HAVING COUNT(*) >= 2
    ) visit_counts ON l.id = visit_counts.location_id
    LEFT JOIN public.relationship_edges edge_info ON (
        edge_info.tenant_id = v_tenant_id
        AND edge_info.source_type = 'person'
        AND edge_info.source_id = v_user_id
        AND edge_info.target_type = 'location'
        AND edge_info.target_id = l.id
        AND edge_info.edge_type = 'visited'
    )
    WHERE l.tenant_id = v_tenant_id
      AND (
          p_topic_keys IS NULL
          OR l.topic_keys && p_topic_keys
      )
    LIMIT 10;

    -- Return combined discovery results
    RETURN jsonb_build_object(
        'ok', true,
        'discovery', jsonb_build_object(
            'locations', COALESCE(v_locations, '[]'::JSONB),
            'frequent_places', COALESCE(v_frequent_locations, '[]'::JSONB),
            'meetups', '[]'::JSONB  -- Placeholder for future meetup integration
        ),
        'query', jsonb_build_object(
            'lat', p_lat,
            'lng', p_lng,
            'radius_km', v_radius_km,
            'topic_keys', p_topic_keys,
            'fallback_city', v_user_city
        )
    );
END;
$$;

-- ===========================================================================
-- 9. RPC FUNCTION: location_get_visits (for GET /api/v1/locations/visits)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.location_get_visits(
    p_from TIMESTAMPTZ DEFAULT NULL,
    p_to TIMESTAMPTZ DEFAULT NULL,
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
    v_visits JSONB;
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

    -- Cap limit
    p_limit := LEAST(100, GREATEST(1, COALESCE(p_limit, 50)));

    -- Query visits with location info
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', lv.id,
                'location_id', lv.location_id,
                'location_name', l.name,
                'location_type', l.location_type,
                'visit_time', lv.visit_time,
                'visit_type', lv.visit_type,
                'notes', lv.notes,
                'metadata', lv.metadata
            )
            ORDER BY lv.visit_time DESC
        ),
        '[]'::JSONB
    )
    INTO v_visits
    FROM public.location_visits lv
    INNER JOIN public.locations l ON lv.location_id = l.id
    WHERE lv.tenant_id = v_tenant_id
      AND lv.user_id = v_user_id
      AND (p_from IS NULL OR lv.visit_time >= p_from)
      AND (p_to IS NULL OR lv.visit_time <= p_to)
    LIMIT p_limit;

    RETURN jsonb_build_object(
        'ok', true,
        'visits', v_visits,
        'query', jsonb_build_object(
            'from', p_from,
            'to', p_to,
            'limit', p_limit
        )
    );
END;
$$;

-- ===========================================================================
-- 10. RPC FUNCTION: location_preferences_get
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.location_preferences_get()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_prefs RECORD;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND'
        );
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED'
        );
    END IF;

    -- Get or create default preferences
    SELECT * INTO v_prefs
    FROM public.location_preferences
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    IF NOT FOUND THEN
        -- Return defaults
        RETURN jsonb_build_object(
            'ok', true,
            'preferences', jsonb_build_object(
                'preferred_radius_km', 10,
                'allow_location_personalization', true,
                'allow_sharing_in_meetups', false,
                'home_city', NULL,
                'home_area', NULL
            ),
            'is_default', true
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'preferences', jsonb_build_object(
            'preferred_radius_km', v_prefs.preferred_radius_km,
            'allow_location_personalization', v_prefs.allow_location_personalization,
            'allow_sharing_in_meetups', v_prefs.allow_sharing_in_meetups,
            'home_city', v_prefs.home_city,
            'home_area', v_prefs.home_area
        ),
        'is_default', false
    );
END;
$$;

-- ===========================================================================
-- 11. RPC FUNCTION: location_preferences_set
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.location_preferences_set(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND'
        );
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED'
        );
    END IF;

    -- Upsert preferences
    INSERT INTO public.location_preferences (
        tenant_id,
        user_id,
        preferred_radius_km,
        allow_location_personalization,
        allow_sharing_in_meetups,
        home_city,
        home_area,
        updated_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        COALESCE((p_payload->>'preferred_radius_km')::INT, 10),
        COALESCE((p_payload->>'allow_location_personalization')::BOOLEAN, true),
        COALESCE((p_payload->>'allow_sharing_in_meetups')::BOOLEAN, false),
        p_payload->>'home_city',
        p_payload->>'home_area',
        NOW()
    )
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET
        preferred_radius_km = COALESCE((p_payload->>'preferred_radius_km')::INT, location_preferences.preferred_radius_km),
        allow_location_personalization = COALESCE((p_payload->>'allow_location_personalization')::BOOLEAN, location_preferences.allow_location_personalization),
        allow_sharing_in_meetups = COALESCE((p_payload->>'allow_sharing_in_meetups')::BOOLEAN, location_preferences.allow_sharing_in_meetups),
        home_city = COALESCE(p_payload->>'home_city', location_preferences.home_city),
        home_area = COALESCE(p_payload->>'home_area', location_preferences.home_area),
        updated_at = NOW();

    RETURN jsonb_build_object(
        'ok', true,
        'message', 'Preferences updated'
    );
END;
$$;

-- ===========================================================================
-- 12. RPC FUNCTION: relationship_edge_strengthen
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.relationship_edge_strengthen(
    p_source_type TEXT,
    p_source_id UUID,
    p_target_type TEXT,
    p_target_id UUID,
    p_edge_type TEXT,
    p_strength_delta INT DEFAULT 5
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_edge_id UUID;
    v_new_strength INT;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Validate source is the current user (for person type)
    IF p_source_type = 'person' AND p_source_id != v_user_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN', 'message', 'Cannot modify edges for other users');
    END IF;

    -- Upsert the edge with strength increment
    INSERT INTO public.relationship_edges (
        tenant_id,
        source_type,
        source_id,
        target_type,
        target_id,
        edge_type,
        strength,
        last_interaction
    ) VALUES (
        v_tenant_id,
        p_source_type,
        p_source_id,
        p_target_type,
        p_target_id,
        p_edge_type,
        LEAST(100, GREATEST(0, p_strength_delta)),
        NOW()
    )
    ON CONFLICT (tenant_id, source_type, source_id, target_type, target_id, edge_type)
    DO UPDATE SET
        strength = LEAST(100, relationship_edges.strength + p_strength_delta),
        last_interaction = NOW()
    RETURNING id, strength INTO v_edge_id, v_new_strength;

    RETURN jsonb_build_object(
        'ok', true,
        'edge_id', v_edge_id,
        'strength', v_new_strength
    );
END;
$$;

-- ===========================================================================
-- 13. PERMISSIONS
-- ===========================================================================

-- RPC functions
GRANT EXECUTE ON FUNCTION public.location_add(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.location_checkin(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.location_nearby_discovery(DOUBLE PRECISION, DOUBLE PRECISION, INT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.location_get_visits(TIMESTAMPTZ, TIMESTAMPTZ, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.location_preferences_get() TO authenticated;
GRANT EXECUTE ON FUNCTION public.location_preferences_set(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.relationship_edge_strengthen(TEXT, UUID, TEXT, UUID, TEXT, INT) TO authenticated;

-- Tables (RLS will enforce row-level access)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.locations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.location_visits TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.location_preferences TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.relationship_edges TO authenticated;

-- ===========================================================================
-- 14. COMMENTS
-- ===========================================================================

COMMENT ON TABLE public.locations IS 'VTID-01091: First-class location memory for users';
COMMENT ON TABLE public.location_visits IS 'VTID-01091: Explicit check-ins and visit records';
COMMENT ON TABLE public.location_preferences IS 'VTID-01091: User privacy and sharing preferences for locations';
COMMENT ON TABLE public.relationship_edges IS 'VTID-01087/01091: Generic relationship graph for connecting entities';

COMMENT ON FUNCTION public.location_add IS 'VTID-01091: Create a new location';
COMMENT ON FUNCTION public.location_checkin IS 'VTID-01091: Check in to a location and strengthen relationship edge';
COMMENT ON FUNCTION public.location_nearby_discovery IS 'VTID-01091: Discover nearby locations, meetups, and services';
COMMENT ON FUNCTION public.location_get_visits IS 'VTID-01091: Get visit history with optional date range';
COMMENT ON FUNCTION public.location_preferences_get IS 'VTID-01091: Get user location preferences';
COMMENT ON FUNCTION public.location_preferences_set IS 'VTID-01091: Update user location preferences';
COMMENT ON FUNCTION public.relationship_edge_strengthen IS 'VTID-01087/01091: Strengthen a relationship edge between entities';
