-- VTID-03413: point the `worker` LLM stage at Anthropic-on-Bedrock.
--
-- WHY
-- ---
-- The autopilot executor runs as an ECS task on AWS (VTID-03415) whose task
-- definition deliberately carries NO LLM API keys (deferred pending an
-- AWS/Anthropic sponsorship decision). Its LLM calls go through
-- `llm-router.ts`, and the ECS task role already grants
-- `bedrock:InvokeModel`, so Bedrock is the one provider that works there
-- with zero secrets.
--
-- WHY THIS IS SAFE FOR GCP, EVEN THOUGH `llm_routing_policy` IS GLOBAL
-- -------------------------------------------------------------------
-- There is no per-cloud policy override — this single row drives both the
-- GCP and AWS gateways. The Bedrock adapter's availability gate is
-- `isAvailable: () => Boolean(process.env.BEDROCK_ROLE_ARN)`
-- (`llm-router.ts`), and GCP's gateway does not set that variable. An
-- unavailable primary returns `{ok:false}` from `runProviderCall()`, which
-- `callViaRouter()` treats like any other primary failure and proceeds to
-- the fallback (verified in `llm-router.ts`, the `=== FALLBACK ===` block).
--
-- So the fallback below is deliberately set to `vertex/gemini-3.1-pro-preview`
-- — which is the CURRENT primary. Net effect:
--   * GCP  : bedrock unavailable -> falls through to gemini-3.1-pro-preview,
--            i.e. exactly the model it uses today. Behaviour preserved.
--   * AWS  : BEDROCK_ROLE_ARN is set on `vitana-gateway-awsdr`, so Bedrock
--            serves the call.
--
-- Known cost of this arrangement, accepted rather than hidden: on GCP every
-- worker-stage call now records one failed `bedrock` attempt (a
-- `failLLMCall` telemetry row + a warn log) before falling back. That is
-- noise in the LLM call log, not a functional regression. If it proves
-- annoying, the fix is a per-cloud policy override, which does not exist
-- yet and would need its own VTID.
--
-- MODEL ID
-- --------
-- UPDATED post-review (PR #2946): the original text here claimed
-- `eu.anthropic.claude-opus-4-7` was verified ACTIVE via
-- `aws bedrock list-inference-profiles` and used it as both the seeded
-- model and the policy's primary_model. That conflates "listed as ACTIVE"
-- with "this account can invoke it" — they are different things, and the
-- gap only surfaces as an `AccessDeniedException` at call time.
-- `20260810120000_vtid_03565_seed_bedrock_allowlist.sql` (a later,
-- independent verification pass with a real `invoke-model` call against
-- account 472838866351) found `eu.anthropic.claude-opus-4-7`
-- AccessDenied and deliberately excluded it, keeping only
-- `eu.anthropic.claude-sonnet-4-6` as verified-invokable. Using opus-4-7
-- here would have meant the worker stage's Bedrock primary failed on
-- every real call — on AWS, falling back to `vertex/gemini-3.1-pro-preview`
-- doesn't work either (no GCP ADC on an AWS ECS task), so the keyless path
-- this migration exists to create would never actually have worked.
-- Fixed to seed and route only the verified-invokable Sonnet 4.6 profile.
--
-- NOT marked applicable to the `vision` stage on purpose: the Bedrock
-- adapter explicitly rejects image/tool payloads (VTID-03403), so claiming
-- vision applicability would let an operator select a combination that
-- always errors.

-- ---------------------------------------------------------------------------
-- 0. Seed the `bedrock` provider row.
--    `llm_allowed_models.provider_key` has a FOREIGN KEY to
--    `llm_allowed_providers(provider_key)` — without this, the model
--    INSERT below fails on a fresh database, since this migration
--    (2026-07-26) runs before VTID-03565's own provider seed (2026-08-10).
--    Idempotent both ways: a no-op if VTID-03565 (or a rerun) already did it.
-- ---------------------------------------------------------------------------
INSERT INTO public.llm_allowed_providers (provider_key, display_name, is_active, config)
SELECT 'bedrock', 'Anthropic Claude via AWS Bedrock', true,
       jsonb_build_object(
         'region_env', 'AWS_BEDROCK_REGION',
         'activation_gate', 'BEDROCK_ROLE_ARN'
       )
WHERE NOT EXISTS (
  SELECT 1 FROM public.llm_allowed_providers WHERE provider_key = 'bedrock'
);

-- ---------------------------------------------------------------------------
-- 1. Register the Bedrock model in the allowlist.
--    `validatePolicy()` rejects any provider/model pair absent from this
--    table, so without this row the policy update below is impossible —
--    and the Command Hub LLM Providers dropdown would not offer Bedrock.
-- ---------------------------------------------------------------------------
INSERT INTO public.llm_allowed_models (
  provider_key, model_id, display_name, is_active, is_recommended,
  applicable_stages, cost_per_1m_input, cost_per_1m_output,
  max_context_tokens, notes
)
VALUES
  (
    'bedrock',
    'eu.anthropic.claude-sonnet-4-6',
    'Claude Sonnet 4.6 (Bedrock, EU)',
    true,
    true,
    ARRAY['planner', 'worker', 'validator', 'operator', 'memory', 'triage', 'classifier'],
    3.00,
    15.00,
    200000,
    'VTID-03413: verified-invokable EU cross-region inference profile (account 472838866351, confirmed by VTID-03565). Reached via the ECS task role''s bedrock:InvokeModel - needs no API key, which is why the keyless autopilot-executor task can use it. No vision/tools (adapter limitation, VTID-03403).'
  )
ON CONFLICT (provider_key, model_id) DO UPDATE SET
  display_name      = EXCLUDED.display_name,
  is_active         = EXCLUDED.is_active,
  is_recommended    = EXCLUDED.is_recommended,
  applicable_stages = EXCLUDED.applicable_stages,
  cost_per_1m_input = EXCLUDED.cost_per_1m_input,
  cost_per_1m_output= EXCLUDED.cost_per_1m_output,
  max_context_tokens= EXCLUDED.max_context_tokens,
  notes             = EXCLUDED.notes,
  updated_at        = NOW();

-- ---------------------------------------------------------------------------
-- 2. New active policy version, derived from the CURRENT active row.
--
--    Built with jsonb_set on the existing policy rather than spelled out in
--    full, so the other five stages carry over byte-for-byte. Writing the
--    whole object by hand risked silently dropping a stage — and note the
--    live row has only six stages (no vision/classifier), which is itself a
--    known mismatch with VALID_STAGES that this migration deliberately does
--    NOT try to fix.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_current  public.llm_routing_policy;
  v_new_policy jsonb;
BEGIN
  SELECT * INTO v_current
  FROM public.llm_routing_policy
  WHERE is_active = true AND environment = 'DEV'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_current.id IS NULL THEN
    RAISE EXCEPTION 'VTID-03413: no active DEV routing policy found - refusing to guess one';
  END IF;

  -- Idempotency: if worker is already on bedrock, do nothing.
  IF v_current.policy -> 'worker' ->> 'primary_provider' = 'bedrock' THEN
    RAISE NOTICE 'VTID-03413: worker stage already routed to bedrock (version %) - no change', v_current.version;
    RETURN;
  END IF;

  v_new_policy := jsonb_set(
    v_current.policy,
    '{worker}',
    jsonb_build_object(
      'primary_provider', 'bedrock',
      'primary_model',    'eu.anthropic.claude-sonnet-4-6',
      -- Fallback = the outgoing primary, so GCP (no BEDROCK_ROLE_ARN)
      -- keeps using the exact model it uses today.
      'fallback_provider', 'vertex',
      'fallback_model',    'gemini-3.1-pro-preview'
    ),
    /* create_if_missing */ true
  );

  UPDATE public.llm_routing_policy
     SET is_active = false, deactivated_at = NOW()
   WHERE id = v_current.id;

  INSERT INTO public.llm_routing_policy (
    environment, version, policy, is_active, created_by, activated_at
  ) VALUES (
    v_current.environment,
    v_current.version + 1,
    v_new_policy,
    true,
    'VTID-03413',
    NOW()
  );

  RAISE NOTICE 'VTID-03413: worker stage -> bedrock/eu.anthropic.claude-sonnet-4-6 (version % -> %)',
    v_current.version, v_current.version + 1;
END $$;
