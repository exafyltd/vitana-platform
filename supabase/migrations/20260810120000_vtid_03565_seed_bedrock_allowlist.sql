-- VTID-03565: seed the Bedrock provider + its invokable models into the
-- governed allowlist tables.
--
-- WHY THIS IS REQUIRED, not cosmetic:
--   `validatePolicy()` (services/llm-routing-policy-service.ts) builds its
--   allowlist exclusively from active `llm_allowed_models` rows and rejects any
--   provider/model pair absent from it. Before this migration there were ZERO
--   bedrock rows in either table — verified against production, not just the
--   migration tree. So widening the route's ProviderEnum to accept 'bedrock'
--   was necessary but NOT sufficient: a POST selecting bedrock cleared the zod
--   gate and was then rejected by the service as an invalid model. The standing
--   rule "Claude always via Bedrock" (VTID-03563) is unstorable without this.
--   Caught in review on #3073.
--
-- THE MODEL LIST IS NOT THE DOCUMENTED ONE — IT IS THE VERIFIED ONE.
--   Every id below was confirmed invokable by a real `bedrock-runtime
--   invoke-model` call against account 472838866351 in eu-central-1 on
--   2026-08-10. `aws bedrock list-inference-profiles` reports many more as
--   status ACTIVE that this account CANNOT invoke — listing a profile and
--   being entitled to it are different things, and the difference surfaces
--   only as an AccessDeniedException at call time.
--
--   DELIBERATELY OMITTED, though ACTIVE in the listing and currently set as
--   BEDROCK_MODEL_ID on the live gateway task definition:
--     eu.anthropic.claude-opus-4-7      -> AccessDeniedException
--     eu.anthropic.claude-opus-4-8      -> AccessDeniedException
--     eu.anthropic.claude-opus-5        -> AccessDeniedException
--     eu.anthropic.claude-sonnet-5      -> AccessDeniedException
--     global.anthropic.*                -> AccessDeniedException
--   Seeding any of those would let an operator select a model that fails on
--   every call and then silently serves the stage's fallback — reproducing the
--   exact defect VTID-03563 exists to end. If entitlement is granted later,
--   add the row THEN, after re-verifying with an invoke.
--
-- Bedrock model ids must be resolved cross-region INFERENCE PROFILE ids, not
-- bare on-demand model ids. Note newer profiles carry no `-v1:0` suffix; that
-- is the current AWS naming, not a malformed id.

BEGIN;

-- ── provider ───────────────────────────────────────────────────────────────
INSERT INTO llm_allowed_providers (provider_key, display_name, is_active, config)
SELECT 'bedrock', 'Anthropic Claude via AWS Bedrock', true,
       jsonb_build_object(
         'region_env', 'AWS_BEDROCK_REGION',
         'activation_gate', 'BEDROCK_ROLE_ARN',
         'note', 'Adapter reports not_configured and the router SKIPS bedrock while BEDROCK_ROLE_ARN is unset — a policy row pointing here would then quietly serve its fallback. Verify with POST /api/v1/llm/providers/verify before flipping routing.'
       )
WHERE NOT EXISTS (
  SELECT 1 FROM llm_allowed_providers WHERE provider_key = 'bedrock'
);

-- ── models (verified invokable only) ───────────────────────────────────────
INSERT INTO llm_allowed_models (
  provider_key, model_id, display_name, is_active, is_recommended,
  applicable_stages, tier, notes
)
SELECT v.provider_key, v.model_id, v.display_name, true, v.is_recommended,
       v.applicable_stages, v.tier, v.notes
FROM (VALUES
  ('bedrock', 'eu.anthropic.claude-sonnet-4-6',
   'Claude Sonnet 4.6 (Bedrock eu)', true,
   ARRAY['planner','worker','validator','operator','memory','triage','vision','classifier']::text[],
   'mid',
   'Verified invokable 2026-08-10. Matches PROVIDER_FLAGSHIPS.bedrock default.'),

  ('bedrock', 'eu.anthropic.claude-opus-4-6-v1',
   'Claude Opus 4.6 (Bedrock eu)', false,
   ARRAY['planner','worker','validator','operator','memory','triage','vision']::text[],
   'flagship',
   'Verified invokable 2026-08-10.'),

  ('bedrock', 'eu.anthropic.claude-opus-4-5-20251101-v1:0',
   'Claude Opus 4.5 (Bedrock eu)', false,
   ARRAY['planner','validator','operator','triage']::text[],
   'flagship',
   'Verified invokable 2026-08-10.'),

  ('bedrock', 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
   'Claude Sonnet 4.5 (Bedrock eu)', false,
   ARRAY['planner','worker','validator','operator','memory','triage','vision','classifier']::text[],
   'mid',
   'Verified invokable 2026-08-10.'),

  ('bedrock', 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
   'Claude Haiku 4.5 (Bedrock eu)', false,
   -- 'validator' and 'operator' are present deliberately, and their absence was
   -- a real defect caught by this migration's own test: ALWAYS 10c requires a
   -- Claude stage's fallback to be another BEDROCK model, and `validator` is the
   -- first stage due to move (it sits on the dead `anthropic` provider today).
   -- Omitting validator here made the cheapest compliant fallback unselectable
   -- and contradicted this row's own stated purpose. `planner` is still excluded
   -- — a degraded planner fallback should step to sonnet/opus, not to light.
   ARRAY['classifier','memory','worker','triage','validator','operator']::text[],
   'light',
   'Verified invokable 2026-08-10. Cheapest verified option — suits a Claude-side FALLBACK, which ALWAYS 10c requires to be another Bedrock model and never Google.')
) AS v(provider_key, model_id, display_name, is_recommended, applicable_stages, tier, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM llm_allowed_models m
  WHERE m.provider_key = v.provider_key AND m.model_id = v.model_id
);

COMMIT;

-- Verify:
--   SELECT provider_key, model_id, applicable_stages, is_active
--   FROM llm_allowed_models WHERE provider_key = 'bedrock' ORDER BY model_id;
-- Expect exactly 5 rows and NO claude-opus-4-7.
