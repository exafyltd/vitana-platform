-- Migration: 20260201000000_vtid_01225_cognee_extractor.sql
-- Purpose: VTID-01225 Cognee Integration - Stateless Entity Extraction Engine
-- Date: 2026-02-01
--
-- Integrates Cognee as a stateless entity extraction service for ORB voice
-- transcripts, outputting normalized entities/relationships to VTID-01087
-- relationship graph tables under full ContextLens governance.
--
-- Dependencies:
--   - VTID-01087 (Relationship Graph Memory) - target for extracted entities
--   - VTID-01224 (ORB Live API Intelligence Stack) - source of transcripts
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--
-- Design Document: docs/architecture/cognee-integration-design.md

-- ===========================================================================
-- A. Register VTID-01225 in OASIS Ledger
-- ===========================================================================

INSERT INTO public.vtid_ledger (
    vtid,
    title,
    description,
    summary,
    status,
    layer,
    module,
    task_family,
    task_type,
    metadata
) VALUES (
    'VTID-01225',
    'Cognee Integration - Stateless Entity Extraction Engine',
    E'Integrate Cognee as a stateless entity extraction service for ORB voice transcripts.\n\n' ||
    E'Architecture:\n' ||
    E'- Cognee Extractor Service: Python Cloud Run, stateless extraction\n' ||
    E'- Gateway endpoint: POST /api/v1/relationships/from-cognee\n' ||
    E'- ORB Live integration: Fire-and-forget transcript processing\n' ||
    E'- Full OASIS monitoring and audit trail\n\n' ||
    E'Key Constraints:\n' ||
    E'- NO Cognee EBAC: Vitana ContextLens handles governance\n' ||
    E'- Dataset per tenant (not per user)\n' ||
    E'- Cognee outputs are advisory; Vitana writes are governed\n' ||
    E'- All persistence to VTID-01087 relationship tables',
    'Cognee Extractor Service: Cloud Run Python service for voice transcript entity/relationship extraction',
    'in_progress',
    'AICOR',
    'COGNEE',
    'AGENTS',
    'EXTRACTOR',
    jsonb_build_object(
        'type', 'service_integration',
        'service', 'cognee-extractor',
        'runtime', 'cloud_run',
        'language', 'python',
        'design_doc', 'docs/architecture/cognee-integration-design.md',
        'dependencies', jsonb_build_array('VTID-01087', 'VTID-01224'),
        'files', jsonb_build_array(
            'services/agents/cognee-extractor/main.py',
            'services/agents/cognee-extractor/requirements.txt',
            'services/agents/cognee-extractor/Dockerfile',
            'services/gateway/src/routes/relationships.ts',
            'services/gateway/src/services/cognee-extractor-client.ts'
        ),
        'endpoints', jsonb_build_object(
            'extractor', '/extract',
            'gateway', 'POST /api/v1/relationships/from-cognee'
        ),
        'oasis_events', jsonb_build_array(
            'cognee.extraction.started',
            'cognee.extraction.completed',
            'cognee.extraction.timeout',
            'cognee.extraction.persisted',
            'cognee.extraction.error'
        ),
        'constraints', jsonb_build_object(
            'no_cognee_ebac', true,
            'dataset_per_tenant', true,
            'stateless_extraction', true,
            'advisory_outputs', true
        )
    )
)
ON CONFLICT (vtid) DO UPDATE SET
    title = EXCLUDED.title,
    description = EXCLUDED.description,
    summary = EXCLUDED.summary,
    status = EXCLUDED.status,
    layer = EXCLUDED.layer,
    module = EXCLUDED.module,
    task_family = EXCLUDED.task_family,
    task_type = EXCLUDED.task_type,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();

-- ===========================================================================
-- B. Add 'cognee' as valid origin for relationship_edges
-- ===========================================================================

-- Note: The existing origin constraint allows 'autopilot' which we use for Cognee.
-- We store 'cognee' in the context JSONB field for more specific provenance.
-- No schema change needed - origin='autopilot' + context.origin='cognee'

-- ===========================================================================
-- C. Create extraction_requests table for async processing tracking
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.cognee_extraction_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    session_id TEXT NOT NULL,
    transcript_hash TEXT NOT NULL,  -- SHA256 of transcript for dedup
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'completed', 'failed', 'skipped')
    ),
    entities_count INT DEFAULT 0,
    relationships_count INT DEFAULT 0,
    signals_count INT DEFAULT 0,
    error_message TEXT NULL,
    processing_ms INT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ NULL,

    -- Dedup: one request per transcript per session
    CONSTRAINT unique_transcript_session UNIQUE (session_id, transcript_hash)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_cognee_extraction_tenant_user
    ON public.cognee_extraction_requests (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_cognee_extraction_status
    ON public.cognee_extraction_requests (status) WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_cognee_extraction_created
    ON public.cognee_extraction_requests (created_at DESC);

-- ===========================================================================
-- D. RLS Policies for extraction_requests
-- ===========================================================================

ALTER TABLE public.cognee_extraction_requests ENABLE ROW LEVEL SECURITY;

-- Users can only see their own extraction requests
DROP POLICY IF EXISTS cognee_extraction_select ON public.cognee_extraction_requests;
CREATE POLICY cognee_extraction_select ON public.cognee_extraction_requests
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- Service role has full access for backend processing
GRANT ALL ON public.cognee_extraction_requests TO service_role;
GRANT SELECT ON public.cognee_extraction_requests TO authenticated;

-- ===========================================================================
-- E. RPC Function: Track extraction request
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.cognee_track_extraction(
    p_session_id TEXT,
    p_transcript_hash TEXT,
    p_status TEXT,
    p_entities_count INT DEFAULT 0,
    p_relationships_count INT DEFAULT 0,
    p_signals_count INT DEFAULT 0,
    p_error_message TEXT DEFAULT NULL,
    p_processing_ms INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_request_id UUID;
    v_is_new BOOLEAN := false;
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

    -- Validate status
    IF p_status NOT IN ('pending', 'processing', 'completed', 'failed', 'skipped') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_STATUS',
            'message', 'status must be one of: pending, processing, completed, failed, skipped'
        );
    END IF;

    -- Upsert extraction request
    INSERT INTO public.cognee_extraction_requests (
        tenant_id,
        user_id,
        session_id,
        transcript_hash,
        status,
        entities_count,
        relationships_count,
        signals_count,
        error_message,
        processing_ms,
        completed_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_session_id,
        p_transcript_hash,
        p_status,
        COALESCE(p_entities_count, 0),
        COALESCE(p_relationships_count, 0),
        COALESCE(p_signals_count, 0),
        p_error_message,
        p_processing_ms,
        CASE WHEN p_status IN ('completed', 'failed', 'skipped') THEN NOW() ELSE NULL END
    )
    ON CONFLICT (session_id, transcript_hash) DO UPDATE SET
        status = EXCLUDED.status,
        entities_count = COALESCE(EXCLUDED.entities_count, cognee_extraction_requests.entities_count),
        relationships_count = COALESCE(EXCLUDED.relationships_count, cognee_extraction_requests.relationships_count),
        signals_count = COALESCE(EXCLUDED.signals_count, cognee_extraction_requests.signals_count),
        error_message = COALESCE(EXCLUDED.error_message, cognee_extraction_requests.error_message),
        processing_ms = COALESCE(EXCLUDED.processing_ms, cognee_extraction_requests.processing_ms),
        completed_at = CASE
            WHEN EXCLUDED.status IN ('completed', 'failed', 'skipped') THEN NOW()
            ELSE cognee_extraction_requests.completed_at
        END
    RETURNING id, (xmax = 0) INTO v_request_id, v_is_new;

    RETURN jsonb_build_object(
        'ok', true,
        'request_id', v_request_id,
        'created', v_is_new,
        'status', p_status
    );
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.cognee_track_extraction(TEXT, TEXT, TEXT, INT, INT, INT, TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cognee_track_extraction(TEXT, TEXT, TEXT, INT, INT, INT, TEXT, INT) TO service_role;

-- ===========================================================================
-- F. Comments
-- ===========================================================================

COMMENT ON TABLE public.cognee_extraction_requests IS 'VTID-01225: Tracks Cognee entity extraction requests for deduplication and monitoring';
COMMENT ON FUNCTION public.cognee_track_extraction IS 'VTID-01225: Track or update a Cognee extraction request status';

-- ===========================================================================
-- G. Initial OASIS Event (task started)
-- ===========================================================================

INSERT INTO public.oasis_events (
    vtid,
    kind,
    status,
    title,
    message,
    source,
    layer,
    module,
    task_stage,
    metadata
) VALUES (
    'VTID-01225',
    'task_lifecycle',
    'in_progress',
    'Cognee Integration - Implementation Started',
    'Starting implementation of Cognee entity extraction service for ORB voice transcripts',
    'migration',
    'AICOR',
    'COGNEE',
    'WORKER',
    jsonb_build_object(
        'migration', '20260201000000_vtid_01225_cognee_extractor.sql',
        'phase', 'implementation',
        'design_doc', 'docs/architecture/cognee-integration-design.md'
    )
);
