-- impact-allow-solo-migration: restores the original SQL function bodies; no gateway or worker code changes.
-- VTID-05571 rollback (pre-approved) of 20261102040400_vtid_05571_writer_repoint.sql.
--
-- NOT meant as a forward step: apply it for real only through RUN-MIGRATION.yml, after the owner approves the
-- rollback and the target database (collaboration.md §7d). It restores the 19 original function bodies verbatim
-- from the legacy migrations. THIS RE-OPENS THE POLLUTION: the restored functions write the dead dev tenant ...0001
-- (and the 01127 ones the dev user ...0099) again when a tenant or user is missing. Use it only to back out a broken
-- repoint, and re-run the cleanup (20261102040300) afterwards.
--
-- Replay order: this file sorts before the forward file ("..._writer_fallback_rollback" < "..._writer_repoint"), so a
-- full replay (supabase db reset) runs it first and the forward file then repoints again; the end state is the
-- repointed one. On a database that never had the lane the bodies it restores are the bodies already live.
-- Grants are untouched (CREATE OR REPLACE keeps them); a function that did not exist yet is locked to service_role.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE vtid05571_rb_before ON COMMIT DROP AS
SELECT p.proname::text AS proname FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
    'availability_compute',
    'availability_get_override',
    'availability_set_override',
    'availability_clear_override',
    'availability_get_recent',
    'd41_set_personal_boundary',
    'd41_set_consent',
    'd43_record_data_point',
    'd43_create_adaptation_plan',
    'd43_create_snapshot',
    'd44_create_signal',
    'd44_add_signal_evidence',
    'd44_update_signal_status',
    'd44_record_intervention',
    'd45_store_window',
    'd45_acknowledge_window',
    'd45_record_forecast_history',
    'd50_store_reinforcement',
    'd50_update_eligibility_cache'
 );

-- 01127: supabase/migrations/20260102200000_vtid_01127_availability_readiness_engine.sql
CREATE OR REPLACE FUNCTION public.availability_compute(
    p_session_id UUID DEFAULT NULL,
    p_turn_id UUID DEFAULT NULL,
    p_availability_level TEXT DEFAULT 'unknown',
    p_availability_confidence INT DEFAULT 50,
    p_availability_factors JSONB DEFAULT '[]'::JSONB,
    p_time_window TEXT DEFAULT 'short',
    p_time_window_confidence INT DEFAULT 50,
    p_estimated_minutes INT DEFAULT NULL,
    p_time_window_factors JSONB DEFAULT '[]'::JSONB,
    p_readiness_score NUMERIC DEFAULT 0.50,
    p_readiness_confidence INT DEFAULT 50,
    p_readiness_factors JSONB DEFAULT '[]'::JSONB,
    p_risk_flags JSONB DEFAULT '[]'::JSONB,
    p_action_depth JSONB DEFAULT '{}'::JSONB,
    p_availability_tag TEXT DEFAULT 'quick_only',
    p_was_user_override BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_assessment_id UUID;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- Get context
    v_tenant_id := current_setting('request.jwt.claims', true)::json->>'tenant_id';
    v_user_id := auth.uid();

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001';
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := '00000000-0000-0000-0000-000000000099';
    END IF;

    -- Set expiry (5 minutes)
    v_expires_at := NOW() + INTERVAL '5 minutes';

    -- Insert assessment
    INSERT INTO public.availability_assessments (
        tenant_id,
        user_id,
        session_id,
        turn_id,
        availability_level,
        availability_confidence,
        availability_factors,
        time_window,
        time_window_confidence,
        estimated_minutes,
        time_window_factors,
        readiness_score,
        readiness_confidence,
        readiness_factors,
        risk_flags,
        action_depth,
        availability_tag,
        was_user_override,
        expires_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_session_id,
        p_turn_id,
        p_availability_level,
        p_availability_confidence,
        p_availability_factors,
        p_time_window,
        p_time_window_confidence,
        p_estimated_minutes,
        p_time_window_factors,
        p_readiness_score,
        p_readiness_confidence,
        p_readiness_factors,
        p_risk_flags,
        p_action_depth,
        p_availability_tag,
        p_was_user_override,
        v_expires_at
    )
    RETURNING id INTO v_assessment_id;

    RETURN jsonb_build_object(
        'ok', true,
        'assessment_id', v_assessment_id,
        'availability_level', p_availability_level,
        'time_window', p_time_window,
        'readiness_score', p_readiness_score,
        'availability_tag', p_availability_tag,
        'expires_at', v_expires_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.availability_get_override(
    p_session_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_override RECORD;
BEGIN
    -- Get context
    v_tenant_id := current_setting('request.jwt.claims', true)::json->>'tenant_id';
    v_user_id := auth.uid();

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001';
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := '00000000-0000-0000-0000-000000000099';
    END IF;

    -- Get active override
    SELECT *
    INTO v_override
    FROM public.availability_overrides
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (session_id = p_session_id OR (session_id IS NULL AND p_session_id IS NULL))
      AND active = true
      AND expires_at > NOW()
    LIMIT 1;

    IF v_override IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'has_override', false
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'has_override', true,
        'override_id', v_override.id,
        'availability_level', v_override.availability_level,
        'time_available_minutes', v_override.time_available_minutes,
        'readiness_override', v_override.readiness_override,
        'expires_at', v_override.expires_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.availability_set_override(
    p_session_id UUID DEFAULT NULL,
    p_availability_level TEXT DEFAULT NULL,
    p_time_available_minutes INT DEFAULT NULL,
    p_readiness_override TEXT DEFAULT NULL,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_override_id UUID;
    v_config RECORD;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- Get context
    v_tenant_id := current_setting('request.jwt.claims', true)::json->>'tenant_id';
    v_user_id := auth.uid();

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001';
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := '00000000-0000-0000-0000-000000000099';
    END IF;

    -- Get config for expiry time
    SELECT override_expiry_minutes INTO v_config
    FROM public.availability_config
    WHERE tenant_id = v_tenant_id;

    IF v_config IS NULL THEN
        v_expires_at := NOW() + INTERVAL '30 minutes';
    ELSE
        v_expires_at := NOW() + (v_config.override_expiry_minutes || ' minutes')::INTERVAL;
    END IF;

    -- Deactivate existing overrides
    UPDATE public.availability_overrides
    SET active = false
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (session_id = p_session_id OR (session_id IS NULL AND p_session_id IS NULL))
      AND active = true;

    -- Insert new override
    INSERT INTO public.availability_overrides (
        tenant_id,
        user_id,
        session_id,
        availability_level,
        time_available_minutes,
        readiness_override,
        reason,
        active,
        expires_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_session_id,
        p_availability_level,
        p_time_available_minutes,
        p_readiness_override,
        p_reason,
        true,
        v_expires_at
    )
    RETURNING id INTO v_override_id;

    RETURN jsonb_build_object(
        'ok', true,
        'override_id', v_override_id,
        'availability_level', p_availability_level,
        'readiness_override', p_readiness_override,
        'expires_at', v_expires_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.availability_clear_override(
    p_session_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_cleared INT;
BEGIN
    -- Get context
    v_tenant_id := current_setting('request.jwt.claims', true)::json->>'tenant_id';
    v_user_id := auth.uid();

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001';
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := '00000000-0000-0000-0000-000000000099';
    END IF;

    -- Deactivate overrides
    UPDATE public.availability_overrides
    SET active = false
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (session_id = p_session_id OR (session_id IS NULL AND p_session_id IS NULL))
      AND active = true;

    GET DIAGNOSTICS v_cleared = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'cleared', v_cleared > 0,
        'count', v_cleared
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.availability_get_recent(
    p_session_id UUID DEFAULT NULL,
    p_limit INT DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_assessments JSONB;
BEGIN
    -- Get context
    v_tenant_id := current_setting('request.jwt.claims', true)::json->>'tenant_id';
    v_user_id := auth.uid();

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001';
    END IF;

    IF v_user_id IS NULL THEN
        v_user_id := '00000000-0000-0000-0000-000000000099';
    END IF;

    SELECT jsonb_agg(
        jsonb_build_object(
            'id', a.id,
            'session_id', a.session_id,
            'availability_level', a.availability_level,
            'time_window', a.time_window,
            'readiness_score', a.readiness_score,
            'availability_tag', a.availability_tag,
            'was_user_override', a.was_user_override,
            'computed_at', a.computed_at
        ) ORDER BY a.computed_at DESC
    )
    INTO v_assessments
    FROM public.availability_assessments a
    WHERE a.tenant_id = v_tenant_id
      AND a.user_id = v_user_id
      AND (p_session_id IS NULL OR a.session_id = p_session_id)
    LIMIT p_limit;

    RETURN jsonb_build_object(
        'ok', true,
        'assessments', COALESCE(v_assessments, '[]'::JSONB),
        'count', jsonb_array_length(COALESCE(v_assessments, '[]'::JSONB))
    );
END;
$$;

-- 01135: database/migrations/20260102_vtid_01135_boundary_consent.sql
CREATE OR REPLACE FUNCTION d41_set_personal_boundary(
    p_boundary_type TEXT,
    p_value TEXT,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_old_value TEXT;
    v_score INTEGER;
    v_action TEXT;
BEGIN
    -- Get current user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        v_user_id := current_setting('request.jwt.claims', true)::jsonb->>'sub';
    END IF;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get tenant
    SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_user_id LIMIT 1;
    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::UUID; -- Default tenant
    END IF;

    -- Calculate score based on value
    v_score := CASE
        WHEN p_value IN ('open', 'stable') THEN 20
        WHEN p_value = 'moderate' THEN 50
        WHEN p_value IN ('guarded', 'limited', 'cautious', 'sensitive') THEN 70
        WHEN p_value IN ('private', 'minimal', 'vulnerable', 'restricted') THEN 85
        WHEN p_value IN ('strict', 'none', 'fragile') THEN 100
        ELSE 50
    END;

    -- Try to get existing boundary
    EXECUTE format('SELECT %I FROM user_personal_boundaries WHERE user_id = $1 AND tenant_id = $2', p_boundary_type)
    INTO v_old_value
    USING v_user_id, v_tenant_id;

    -- Upsert boundary
    INSERT INTO user_personal_boundaries (
        tenant_id, user_id,
        privacy_level, privacy_score,
        health_sensitivity, health_sensitivity_score,
        monetization_tolerance, monetization_score,
        social_exposure_limit, social_exposure_score,
        emotional_safety_level, emotional_safety_score,
        source, confidence
    )
    VALUES (
        v_tenant_id, v_user_id,
        CASE WHEN p_boundary_type = 'privacy_level' THEN p_value ELSE 'moderate' END,
        CASE WHEN p_boundary_type = 'privacy_level' THEN v_score ELSE 50 END,
        CASE WHEN p_boundary_type = 'health_sensitivity' THEN p_value ELSE 'moderate' END,
        CASE WHEN p_boundary_type = 'health_sensitivity' THEN v_score ELSE 50 END,
        CASE WHEN p_boundary_type = 'monetization_tolerance' THEN p_value ELSE 'moderate' END,
        CASE WHEN p_boundary_type = 'monetization_tolerance' THEN v_score ELSE 50 END,
        CASE WHEN p_boundary_type = 'social_exposure_limit' THEN p_value ELSE 'moderate' END,
        CASE WHEN p_boundary_type = 'social_exposure_limit' THEN v_score ELSE 50 END,
        CASE WHEN p_boundary_type = 'emotional_safety_level' THEN p_value ELSE 'cautious' END,
        CASE WHEN p_boundary_type = 'emotional_safety_level' THEN v_score ELSE 50 END,
        'explicit', 100
    )
    ON CONFLICT (tenant_id, user_id)
    DO UPDATE SET
        privacy_level = CASE WHEN p_boundary_type = 'privacy_level' THEN p_value ELSE user_personal_boundaries.privacy_level END,
        privacy_score = CASE WHEN p_boundary_type = 'privacy_level' THEN v_score ELSE user_personal_boundaries.privacy_score END,
        health_sensitivity = CASE WHEN p_boundary_type = 'health_sensitivity' THEN p_value ELSE user_personal_boundaries.health_sensitivity END,
        health_sensitivity_score = CASE WHEN p_boundary_type = 'health_sensitivity' THEN v_score ELSE user_personal_boundaries.health_sensitivity_score END,
        monetization_tolerance = CASE WHEN p_boundary_type = 'monetization_tolerance' THEN p_value ELSE user_personal_boundaries.monetization_tolerance END,
        monetization_score = CASE WHEN p_boundary_type = 'monetization_tolerance' THEN v_score ELSE user_personal_boundaries.monetization_score END,
        social_exposure_limit = CASE WHEN p_boundary_type = 'social_exposure_limit' THEN p_value ELSE user_personal_boundaries.social_exposure_limit END,
        social_exposure_score = CASE WHEN p_boundary_type = 'social_exposure_limit' THEN v_score ELSE user_personal_boundaries.social_exposure_score END,
        emotional_safety_level = CASE WHEN p_boundary_type = 'emotional_safety_level' THEN p_value ELSE user_personal_boundaries.emotional_safety_level END,
        emotional_safety_score = CASE WHEN p_boundary_type = 'emotional_safety_level' THEN v_score ELSE user_personal_boundaries.emotional_safety_score END,
        source = 'explicit',
        confidence = 100,
        updated_at = NOW();

    v_action := CASE WHEN v_old_value IS NULL THEN 'boundary_created' ELSE 'boundary_updated' END;

    RETURN jsonb_build_object(
        'ok', true,
        'boundary_type', p_boundary_type,
        'old_value', v_old_value,
        'new_value', p_value,
        'action', v_action
    );
END;
$$;

CREATE OR REPLACE FUNCTION d41_set_consent(
    p_topic TEXT,
    p_status TEXT,
    p_expires_at TIMESTAMPTZ DEFAULT NULL,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_consent_id UUID;
    v_action TEXT;
BEGIN
    -- Get current user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        v_user_id := current_setting('request.jwt.claims', true)::jsonb->>'sub';
    END IF;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get tenant
    SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_user_id LIMIT 1;
    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::UUID;
    END IF;

    -- Check if consent exists
    SELECT id INTO v_consent_id
    FROM user_consent_states
    WHERE user_id = v_user_id AND tenant_id = v_tenant_id AND topic = p_topic;

    IF v_consent_id IS NOT NULL THEN
        -- Update existing
        UPDATE user_consent_states
        SET
            status = p_status,
            confidence = 100,
            granted_at = CASE WHEN p_status = 'granted' THEN NOW() ELSE granted_at END,
            denied_at = CASE WHEN p_status IN ('denied', 'revoked') THEN NOW() ELSE denied_at END,
            expires_at = p_expires_at,
            source = 'explicit',
            source_reference = p_reason,
            updated_at = NOW()
        WHERE id = v_consent_id;

        v_action := 'consent_updated';
    ELSE
        -- Insert new
        INSERT INTO user_consent_states (
            tenant_id, user_id, topic, status, confidence,
            granted_at, denied_at, expires_at, source, source_reference
        )
        VALUES (
            v_tenant_id, v_user_id, p_topic, p_status, 100,
            CASE WHEN p_status = 'granted' THEN NOW() ELSE NULL END,
            CASE WHEN p_status IN ('denied', 'revoked') THEN NOW() ELSE NULL END,
            p_expires_at, 'explicit', p_reason
        )
        RETURNING id INTO v_consent_id;

        v_action := 'consent_created';
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_consent_id,
        'topic', p_topic,
        'status', p_status,
        'expires_at', p_expires_at,
        'action', v_action
    );
END;
$$;

-- 01137: database/migrations/20260102_vtid_01137_d43_longitudinal_adaptation.sql
CREATE OR REPLACE FUNCTION d43_record_data_point(
    p_domain TEXT,
    p_key TEXT,
    p_value JSONB,
    p_numeric_value DOUBLE PRECISION DEFAULT NULL,
    p_source TEXT DEFAULT 'behavioral',
    p_confidence INTEGER DEFAULT 70,
    p_metadata JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_id UUID;
BEGIN
    -- Get user context
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get tenant from user metadata or default
    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    -- Insert data point
    INSERT INTO d43_longitudinal_data_points (
        tenant_id, user_id, domain, key, value,
        numeric_value, source, confidence, metadata
    ) VALUES (
        v_tenant_id, v_user_id, p_domain, p_key, p_value,
        p_numeric_value, p_source, p_confidence, COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_id,
        'domain', p_domain,
        'key', p_key
    );
END;
$$;

CREATE OR REPLACE FUNCTION d43_create_adaptation_plan(
    p_plan JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    INSERT INTO d43_adaptation_plans (
        tenant_id, user_id, domains_to_update, adaptation_strength,
        confirmation_needed, confidence, triggered_by_drift_id, triggered_by,
        status, can_rollback, rollback_until
    ) VALUES (
        v_tenant_id,
        v_user_id,
        COALESCE(p_plan->>'domains_to_update', '[]')::jsonb,
        COALESCE((p_plan->>'adaptation_strength')::integer, 50),
        COALESCE((p_plan->>'confirmation_needed')::boolean, true),
        COALESCE((p_plan->>'confidence')::integer, 50),
        (p_plan->>'triggered_by_drift_id')::uuid,
        COALESCE(p_plan->>'triggered_by', 'drift_detection'),
        COALESCE(p_plan->>'status', 'proposed'),
        COALESCE((p_plan->>'can_rollback')::boolean, true),
        (p_plan->>'rollback_until')::timestamptz
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION d43_create_snapshot(
    p_snapshot_type TEXT,
    p_adaptation_plan_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_id UUID;
    v_domains JSONB;
    v_expires_at TIMESTAMPTZ;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    -- Collect current preference state from various sources
    -- This is a simplified version - would aggregate from d27_preferences, etc.
    v_domains := jsonb_build_object(
        'snapshot_time', NOW(),
        'type', p_snapshot_type
    );

    -- Set expiry (30 days for rollback support)
    v_expires_at := NOW() + INTERVAL '30 days';

    INSERT INTO d43_preference_snapshots (
        tenant_id, user_id, snapshot_type, domains,
        adaptation_plan_id, expires_at
    ) VALUES (
        v_tenant_id, v_user_id, p_snapshot_type, v_domains,
        p_adaptation_plan_id, v_expires_at
    )
    RETURNING id INTO v_id;

    -- If this is for an adaptation plan, link it back
    IF p_adaptation_plan_id IS NOT NULL THEN
        UPDATE d43_adaptation_plans
        SET snapshot_id = v_id
        WHERE id = p_adaptation_plan_id AND user_id = v_user_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_id,
        'type', p_snapshot_type,
        'expires_at', v_expires_at
    );
END;
$$;

-- 01138: database/migrations/20260103_vtid_01138_d44_signal_detection.sql
CREATE OR REPLACE FUNCTION d44_create_signal(
    p_signal JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_id UUID;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- Get user context
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get tenant from user metadata or default
    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    -- Calculate expiration based on time window
    v_expires_at := CASE
        WHEN p_signal->>'time_window' = 'last_7_days' THEN NOW() + INTERVAL '7 days'
        WHEN p_signal->>'time_window' = 'last_14_days' THEN NOW() + INTERVAL '14 days'
        WHEN p_signal->>'time_window' = 'last_30_days' THEN NOW() + INTERVAL '30 days'
        ELSE NOW() + INTERVAL '14 days'
    END;

    -- Insert signal
    INSERT INTO d44_predictive_signals (
        tenant_id, user_id, signal_type, confidence, time_window,
        detected_change, user_impact, suggested_action, explainability_text,
        evidence_count, detection_source, domains_analyzed, data_points_analyzed,
        linked_drift_event_id, linked_memory_refs, linked_health_refs, linked_context_refs,
        expires_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_signal->>'signal_type',
        COALESCE((p_signal->>'confidence')::integer, 70),
        COALESCE(p_signal->>'time_window', 'last_14_days'),
        p_signal->>'detected_change',
        COALESCE(p_signal->>'user_impact', 'medium'),
        COALESCE(p_signal->>'suggested_action', 'awareness'),
        p_signal->>'explainability_text',
        COALESCE((p_signal->>'evidence_count')::integer, 0),
        COALESCE(p_signal->>'detection_source', 'engine'),
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_signal->'domains_analyzed')), '{}'),
        COALESCE((p_signal->>'data_points_analyzed')::integer, 0),
        (p_signal->>'linked_drift_event_id')::uuid,
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_signal->'linked_memory_refs')), '{}'),
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_signal->'linked_health_refs')), '{}'),
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_signal->'linked_context_refs')), '{}'),
        v_expires_at
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_id,
        'signal_type', p_signal->>'signal_type',
        'expires_at', v_expires_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION d44_add_signal_evidence(
    p_signal_id UUID,
    p_evidence JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_id UUID;
    v_signal_exists BOOLEAN;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Verify signal exists and belongs to user
    SELECT EXISTS(
        SELECT 1 FROM d44_predictive_signals
        WHERE id = p_signal_id AND user_id = v_user_id
    ) INTO v_signal_exists;

    IF NOT v_signal_exists THEN
        RETURN jsonb_build_object('ok', false, 'error', 'SIGNAL_NOT_FOUND');
    END IF;

    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    INSERT INTO d44_signal_evidence (
        tenant_id, user_id, signal_id, evidence_type, source_ref,
        source_table, weight, summary, recorded_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_signal_id,
        p_evidence->>'evidence_type',
        p_evidence->>'source_ref',
        p_evidence->>'source_table',
        COALESCE((p_evidence->>'weight')::integer, 50),
        p_evidence->>'summary',
        COALESCE((p_evidence->>'recorded_at')::timestamptz, NOW())
    )
    RETURNING id INTO v_id;

    -- Update evidence count on signal
    UPDATE d44_predictive_signals
    SET evidence_count = evidence_count + 1,
        updated_at = NOW()
    WHERE id = p_signal_id;

    RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION d44_update_signal_status(
    p_signal_id UUID,
    p_status TEXT,
    p_feedback TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_old_status TEXT;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get current status
    SELECT status INTO v_old_status
    FROM d44_predictive_signals
    WHERE id = p_signal_id AND user_id = v_user_id;

    IF v_old_status IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    END IF;

    -- Update status
    UPDATE d44_predictive_signals
    SET status = p_status,
        acknowledged_at = CASE WHEN p_status = 'acknowledged' THEN NOW() ELSE acknowledged_at END,
        actioned_at = CASE WHEN p_status = 'actioned' THEN NOW() ELSE actioned_at END,
        user_feedback = COALESCE(p_feedback, user_feedback),
        updated_at = NOW()
    WHERE id = p_signal_id AND user_id = v_user_id;

    -- Get tenant for history
    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    -- Record in history
    INSERT INTO d44_intervention_history (
        tenant_id, user_id, signal_id, action_type, action_details
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_signal_id,
        p_status,
        jsonb_build_object('feedback', p_feedback, 'old_status', v_old_status)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_signal_id,
        'old_status', v_old_status,
        'new_status', p_status
    );
END;
$$;

CREATE OR REPLACE FUNCTION d44_record_intervention(
    p_signal_id UUID,
    p_action_type TEXT,
    p_action_details JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_id UUID;
    v_signal_exists BOOLEAN;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Verify signal exists and belongs to user
    SELECT EXISTS(
        SELECT 1 FROM d44_predictive_signals
        WHERE id = p_signal_id AND user_id = v_user_id
    ) INTO v_signal_exists;

    IF NOT v_signal_exists THEN
        RETURN jsonb_build_object('ok', false, 'error', 'SIGNAL_NOT_FOUND');
    END IF;

    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    INSERT INTO d44_intervention_history (
        tenant_id, user_id, signal_id, action_type, action_details
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_signal_id,
        p_action_type,
        p_action_details
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

-- 01139: database/migrations/20260103_vtid_01139_d45_predictive_risk_forecasting.sql
CREATE OR REPLACE FUNCTION d45_store_window(
    p_window JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_id UUID;
    v_severity INTEGER;
    v_leverage INTEGER;
BEGIN
    -- Get user context
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get tenant from user metadata or default
    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    -- Set severity/leverage based on window type
    IF p_window->>'window_type' = 'risk' THEN
        v_severity := COALESCE((p_window->>'confidence')::integer, 50);
        v_leverage := NULL;
    ELSE
        v_severity := NULL;
        v_leverage := COALESCE((p_window->>'confidence')::integer, 50);
    END IF;

    -- Insert window
    INSERT INTO d45_predictive_windows (
        id, tenant_id, user_id, window_type, domain, time_horizon,
        start_time, end_time, confidence, severity, leverage,
        drivers, historical_precedent, recommended_mode, explainability_text,
        status, forecast_id
    ) VALUES (
        COALESCE((p_window->>'window_id')::uuid, gen_random_uuid()),
        v_tenant_id,
        v_user_id,
        p_window->>'window_type',
        p_window->>'domain',
        COALESCE(p_window->>'time_horizon', 'short'),
        (p_window->>'start_time')::timestamptz,
        (p_window->>'end_time')::timestamptz,
        COALESCE((p_window->>'confidence')::integer, 50),
        v_severity,
        v_leverage,
        COALESCE(p_window->'drivers', '[]'::jsonb),
        p_window->>'historical_precedent',
        COALESCE(p_window->>'recommended_mode', 'awareness'),
        COALESCE(p_window->>'explainability_text', 'Forecast based on observed patterns.'),
        'upcoming',
        (p_window->>'forecast_id')::uuid
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_id,
        'window_type', p_window->>'window_type',
        'domain', p_window->>'domain'
    );
END;
$$;

CREATE OR REPLACE FUNCTION d45_acknowledge_window(
    p_window_id UUID,
    p_feedback TEXT DEFAULT NULL,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_window_exists BOOLEAN;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Check if window exists
    SELECT EXISTS(
        SELECT 1 FROM d45_predictive_windows
        WHERE id = p_window_id AND user_id = v_user_id
    ) INTO v_window_exists;

    IF NOT v_window_exists THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
    END IF;

    -- Update window status
    UPDATE d45_predictive_windows
    SET status = 'acknowledged',
        acknowledged_at = NOW(),
        updated_at = NOW()
    WHERE id = p_window_id AND user_id = v_user_id;

    -- Record feedback if provided
    IF p_feedback IS NOT NULL THEN
        SELECT raw_user_meta_data->>'tenant_id'
        INTO v_tenant_id
        FROM auth.users
        WHERE id = v_user_id;

        IF v_tenant_id IS NULL THEN
            v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
        END IF;

        INSERT INTO d45_window_feedback (
            tenant_id, user_id, window_id, feedback_type, notes
        ) VALUES (
            v_tenant_id, v_user_id, p_window_id, p_feedback, p_notes
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'window_id', p_window_id,
        'acknowledged_at', NOW()
    );
END;
$$;

CREATE OR REPLACE FUNCTION d45_record_forecast_history(
    p_horizons TEXT[],
    p_domains TEXT[],
    p_signals_analyzed INTEGER,
    p_patterns_matched INTEGER,
    p_risk_windows INTEGER,
    p_opportunity_windows INTEGER,
    p_duration_ms INTEGER,
    p_input_summary JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    INSERT INTO d45_forecast_history (
        tenant_id, user_id, horizons, domains,
        signals_analyzed, patterns_matched,
        risk_windows_generated, opportunity_windows_generated,
        computation_duration_ms, input_summary
    ) VALUES (
        v_tenant_id, v_user_id, p_horizons, p_domains,
        p_signals_analyzed, p_patterns_matched,
        p_risk_windows, p_opportunity_windows,
        p_duration_ms, p_input_summary
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- 01144: database/migrations/20260103_vtid_01144_positive_trajectory_reinforcement.sql
CREATE OR REPLACE FUNCTION d50_store_reinforcement(
    p_trajectory_type TEXT,
    p_confidence INTEGER,
    p_what_is_working TEXT,
    p_why_it_matters TEXT,
    p_suggested_focus TEXT DEFAULT NULL,
    p_source_signals UUID[] DEFAULT '{}',
    p_source_trends TEXT[] DEFAULT '{}',
    p_context_snapshot JSONB DEFAULT NULL,
    p_dismissible BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_reinforcement_id UUID;
BEGIN
    -- Get user context
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get tenant from user metadata or default
    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    -- Insert reinforcement
    INSERT INTO d50_positive_reinforcements (
        tenant_id, user_id, trajectory_type, confidence,
        what_is_working, why_it_matters, suggested_focus,
        source_signals, source_trends, context_snapshot,
        dismissible, generated_at
    ) VALUES (
        v_tenant_id, v_user_id, p_trajectory_type, p_confidence,
        p_what_is_working, p_why_it_matters, p_suggested_focus,
        COALESCE(p_source_signals, '{}'),
        COALESCE(p_source_trends, '{}'),
        COALESCE(p_context_snapshot, '{}'::jsonb),
        p_dismissible, NOW()
    )
    RETURNING reinforcement_id INTO v_reinforcement_id;

    -- Update eligibility cache
    INSERT INTO d50_trajectory_eligibility_cache (
        tenant_id, user_id, trajectory_type,
        last_reinforcement_id, last_reinforcement_at,
        days_since_last_reinforcement, computed_at, expires_at
    ) VALUES (
        v_tenant_id, v_user_id, p_trajectory_type,
        v_reinforcement_id, NOW(),
        0, NOW(), NOW() + INTERVAL '1 hour'
    )
    ON CONFLICT (user_id, trajectory_type) DO UPDATE SET
        last_reinforcement_id = v_reinforcement_id,
        last_reinforcement_at = NOW(),
        days_since_last_reinforcement = 0,
        is_eligible = FALSE,  -- No longer eligible after reinforcement
        computed_at = NOW(),
        expires_at = NOW() + INTERVAL '1 hour';

    RETURN jsonb_build_object(
        'ok', true,
        'reinforcement_id', v_reinforcement_id,
        'trajectory_type', p_trajectory_type
    );
END;
$$;

CREATE OR REPLACE FUNCTION d50_update_eligibility_cache(
    p_trajectory_type TEXT,
    p_is_eligible BOOLEAN,
    p_confidence INTEGER,
    p_days_sustained INTEGER,
    p_evidence_summary TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_last_reinforcement_id UUID;
    v_last_reinforcement_at TIMESTAMPTZ;
    v_days_since INTEGER;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get tenant
    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

    -- Get last reinforcement info
    SELECT reinforcement_id, generated_at
    INTO v_last_reinforcement_id, v_last_reinforcement_at
    FROM d50_positive_reinforcements
    WHERE user_id = v_user_id
      AND trajectory_type = p_trajectory_type
    ORDER BY generated_at DESC
    LIMIT 1;

    IF v_last_reinforcement_at IS NOT NULL THEN
        v_days_since := EXTRACT(DAY FROM NOW() - v_last_reinforcement_at)::integer;
    END IF;

    -- Upsert cache
    INSERT INTO d50_trajectory_eligibility_cache (
        tenant_id, user_id, trajectory_type,
        is_eligible, confidence, days_sustained, evidence_summary,
        last_reinforcement_id, last_reinforcement_at, days_since_last_reinforcement,
        computed_at, expires_at
    ) VALUES (
        v_tenant_id, v_user_id, p_trajectory_type,
        p_is_eligible, p_confidence, p_days_sustained, p_evidence_summary,
        v_last_reinforcement_id, v_last_reinforcement_at, v_days_since,
        NOW(), NOW() + INTERVAL '1 hour'
    )
    ON CONFLICT (user_id, trajectory_type) DO UPDATE SET
        is_eligible = p_is_eligible,
        confidence = p_confidence,
        days_sustained = p_days_sustained,
        evidence_summary = p_evidence_summary,
        last_reinforcement_id = v_last_reinforcement_id,
        last_reinforcement_at = v_last_reinforcement_at,
        days_since_last_reinforcement = v_days_since,
        computed_at = NOW(),
        expires_at = NOW() + INTERVAL '1 hour';

    RETURN jsonb_build_object(
        'ok', true,
        'trajectory_type', p_trajectory_type,
        'is_eligible', p_is_eligible
    );
END;
$$;

DO $post$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS fn, p.proname::text AS proname FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
    'availability_compute',
    'availability_get_override',
    'availability_set_override',
    'availability_clear_override',
    'availability_get_recent',
    'd41_set_personal_boundary',
    'd41_set_consent',
    'd43_record_data_point',
    'd43_create_adaptation_plan',
    'd43_create_snapshot',
    'd44_create_signal',
    'd44_add_signal_evidence',
    'd44_update_signal_status',
    'd44_record_intervention',
    'd45_store_window',
    'd45_acknowledge_window',
    'd45_record_forecast_history',
    'd50_store_reinforcement',
    'd50_update_eligibility_cache'
            )
  LOOP
    IF NOT EXISTS (SELECT 1 FROM vtid05571_rb_before b WHERE b.proname = r.proname) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.fn);
    END IF;
  END LOOP;
END
$post$;

COMMIT;
