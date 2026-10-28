-- VTID-02686: route dev autopilot through Vertex / Gemini 3.1 Pro Preview
-- =============================================================================
-- Reason: autopilot-worker daemon is not deployed on Cloud Run, so worker-
-- mode tasks sit in pending forever. We're flipping the gateway to
-- direct-mode (DEV_AUTOPILOT_USE_WORKER=false in EXEC-DEPLOY.yml) and
-- pointing the planner + worker stages at Gemini 3.1 Pro Preview, which
-- is competitive with Sonnet 4 on coding while being substantially cheaper
-- and runs through Vertex (already wired with ADC on the gateway service
-- account). Anthropic stays as the fallback for both stages.
--
-- This is a JSONB policy update, not a schema change.

-- Add Gemini 3.1 Pro Preview to llm_allowed_models so the audit/UI shows
-- pricing + applicability. The actual Vertex SDK call passes the model id
-- through verbatim, so this row's only job is metadata.
INSERT INTO public.llm_allowed_models (
  provider_key, model_id, display_name, is_active, is_recommended,
  applicable_stages, cost_per_1m_input, cost_per_1m_output,
  max_context_tokens, notes
)
VALUES (
  'vertex',
  'gemini-3.1-pro-preview',
  'Gemini 3.1 Pro Preview',
  true,
  true,
  ARRAY['planner', 'worker', 'validator', 'operator', 'memory', 'triage', 'classifier'],
  1.25,
  5.00,
  2000000,
  'VTID-02686: dev autopilot planner + worker. Strong coding performance, ~3x cheaper than Sonnet 4. Routed via Vertex AI (gateway service account has Vertex AI User role).'
)
ON CONFLICT (provider_key, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  is_active = EXCLUDED.is_active,
  is_recommended = EXCLUDED.is_recommended,
  applicable_stages = EXCLUDED.applicable_stages,
  cost_per_1m_input = EXCLUDED.cost_per_1m_input,
  cost_per_1m_output = EXCLUDED.cost_per_1m_output,
  max_context_tokens = EXCLUDED.max_context_tokens,
  notes = EXCLUDED.notes,
  updated_at = NOW();

-- Insert a new active llm_routing_policy version. Deactivate any prior
-- active version for the same environment first so the unique-active
-- invariant holds.
DO $$
DECLARE
  v_next_version INTEGER;
BEGIN
  -- Compute the next version number
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_next_version
  FROM public.llm_routing_policy
  WHERE environment = 'DEV';

  -- Deactivate the current active row(s)
  UPDATE public.llm_routing_policy
  SET is_active = false,
      deactivated_at = NOW()
  WHERE environment = 'DEV' AND is_active = true;

  -- Insert the new active policy. planner + worker → vertex/gemini-3.1-pro-preview.
  -- Anthropic Sonnet stays as the fallback for safety.
  INSERT INTO public.llm_routing_policy (
    environment, version, is_active, policy, created_by, activated_at
  )
  VALUES (
    'DEV',
    v_next_version,
    true,
    jsonb_build_object(
      'planner', jsonb_build_object(
        'primary_provider', 'vertex',
        'primary_model', 'gemini-3.1-pro-preview',
        'fallback_provider', 'anthropic',
        'fallback_model', 'claude-3-5-sonnet-20241022'
      ),
      'worker', jsonb_build_object(
        'primary_provider', 'vertex',
        'primary_model', 'gemini-3.1-pro-preview',
        'fallback_provider', 'anthropic',
        'fallback_model', 'claude-3-5-sonnet-20241022'
      ),
      'validator', jsonb_build_object(
        'primary_provider', 'anthropic',
        'primary_model', 'claude-3-5-sonnet-20241022',
        'fallback_provider', 'vertex',
        'fallback_model', 'gemini-3.1-pro-preview'
      ),
      'operator', jsonb_build_object(
        'primary_provider', 'vertex',
        'primary_model', 'gemini-2.5-pro',
        'fallback_provider', 'anthropic',
        'fallback_model', 'claude-3-5-sonnet-20241022'
      ),
      'memory', jsonb_build_object(
        'primary_provider', 'anthropic',
        'primary_model', 'claude-3-5-sonnet-20241022',
        'fallback_provider', 'vertex',
        'fallback_model', 'gemini-2.5-pro'
      ),
      'triage', jsonb_build_object(
        'primary_provider', 'vertex',
        'primary_model', 'gemini-3.1-pro-preview',
        'fallback_provider', 'anthropic',
        'fallback_model', 'claude-3-5-sonnet-20241022'
      )
    ),
    'system-vtid-02686',
    NOW()
  );

  RAISE NOTICE 'VTID-02686: activated llm_routing_policy version %', v_next_version;
END $$;

-- Sanity check: emit the active policy for the deploy logs.
SELECT
  environment,
  version,
  is_active,
  policy->'planner'->>'primary_provider' AS planner_provider,
  policy->'planner'->>'primary_model'    AS planner_model,
  policy->'worker'->>'primary_provider'  AS worker_provider,
  policy->'worker'->>'primary_model'     AS worker_model
FROM public.llm_routing_policy
WHERE environment = 'DEV' AND is_active = true;
