-- =============================================================================
-- BOOTSTRAP-DEEPSEEK-V4.1-FLASH (2026-09-11)
-- =============================================================================
-- DeepSeek retired the two-tier deepseek-chat (V3) / deepseek-reasoner (R1)
-- naming. Per DeepSeek's own API changelog (announced 2026-07-24, ~3-month
-- discontinuation window): both legacy names are still accepted today but
-- already alias to the non-thinking/thinking mode of the same current model,
-- and requests against either are now served by DeepSeek-V4.1-Flash (API
-- model id: 'deepseek-flash'). The gateway code (services/gateway/src/
-- constants/llm-defaults.ts, services/gateway/src/services/
-- architecture-investigator.ts, services/worker-runner, services/agents/
-- cognee-extractor) has been updated in this same change to call
-- 'deepseek-flash' directly rather than wait for the legacy aliases to
-- actually break.
--
-- This migration brings the two DB-stored catalogs that mirror that code in
-- sync:
--   1. llm_allowed_models — the Command Hub dropdown's model catalog.
--   2. agents_registry    — the Command Hub Agents page's per-agent metadata.
--
-- Deliberately NOT touched here: the ACTIVE row(s) in llm_routing_policy.
-- That table is normally mutated through the Command Hub (§2b of CLAUDE.md),
-- an operator may have changed it since any bootstrap migration seeded it,
-- and this migration's authoring session has no live DB access to read its
-- current JSON before writing to it. Blindly rewriting jsonb fields on a
-- row whose current shape is unverified risks clobbering an unrelated
-- operator change — see CLAUDE.md Part 1 NEVER rule 6 ("never assume
-- context that is not verified"). The compiled-in LLM_SAFE_DEFAULTS (what
-- serves when the policy read fails, or a stage is missing from the stored
-- row) is already correct as of this change. If any ACTIVE llm_routing_policy
-- row still stores a literal 'deepseek-chat'/'deepseek-reasoner' fallback_model
-- string, an operator needs to flip it via the Command Hub dropdown (now
-- offering 'deepseek-flash') or a follow-up migration written against the
-- row's actual, verified live content.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. llm_allowed_models: add the current model, demote the retired aliases
--    from "recommended" (kept active — DeepSeek is still serving them during
--    the deprecation window — but no longer what the dropdown should suggest).
-- -----------------------------------------------------------------------------

INSERT INTO llm_allowed_models
  (provider_key, model_id, display_name, is_active, is_recommended, applicable_stages, cost_per_1m_input, cost_per_1m_output, max_context_tokens, notes, tier)
VALUES
  ('deepseek', 'deepseek-flash', 'DeepSeek V4.1 Flash (current, flagship)', true, true,
   ARRAY['planner','worker','validator','operator','memory','triage','classifier'],
   0.15, 0.60, 1000000,
   'DeepSeek flagship (default) as of BOOTSTRAP-DEEPSEEK-V4.1-FLASH. Replaces deepseek-reasoner/deepseek-chat, which DeepSeek has put on a discontinuation clock. Off-peak, cache-miss rates — DeepSeek doubles at peak and offers a cheaper cache-hit input tier not modeled here.',
   'flagship')
ON CONFLICT (provider_key, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  is_active = EXCLUDED.is_active,
  is_recommended = EXCLUDED.is_recommended,
  applicable_stages = EXCLUDED.applicable_stages,
  cost_per_1m_input = EXCLUDED.cost_per_1m_input,
  cost_per_1m_output = EXCLUDED.cost_per_1m_output,
  max_context_tokens = EXCLUDED.max_context_tokens,
  notes = EXCLUDED.notes,
  tier = EXCLUDED.tier,
  updated_at = NOW();

UPDATE llm_allowed_models
SET
  is_recommended = false,
  notes = 'RETIRED ALIAS (BOOTSTRAP-DEEPSEEK-V4.1-FLASH, 2026-09-11): DeepSeek is discontinuing this name (~3 months from their 2026-07-24 announcement). Requests already route to DeepSeek-V4.1-Flash under the hood. Use deepseek-flash for new configuration.',
  updated_at = NOW()
WHERE provider_key = 'deepseek' AND model_id IN ('deepseek-reasoner', 'deepseek-chat');

-- -----------------------------------------------------------------------------
-- 2. agents_registry: architecture-investigator (self-healing root-cause
--    agent) — hardcoded llm_model in the registry row, matching the code
--    default in architecture-investigator.ts.
-- -----------------------------------------------------------------------------

UPDATE agents_registry
SET
  llm_model   = 'deepseek-flash',
  description = 'System-wide root-cause hypothesis agent. Reads OASIS incident events + code + recent commits, calls DeepSeek (deepseek-flash, DeepSeek-V4.1-Flash) for a structured root-cause hypothesis with suggested fix and ≥2 alternatives. Hypotheses are advisory; humans decide whether to execute.',
  metadata    = metadata || jsonb_build_object('model_migration', 'BOOTSTRAP-DEEPSEEK-V4.1-FLASH')
WHERE agent_id = 'architecture-investigator' AND llm_model = 'deepseek-reasoner';

-- -----------------------------------------------------------------------------
-- 3. agents_registry: cognee-extractor — the 'swap_candidate' metadata field
--    named the specific model an operator would flip LLM_MODEL to.
-- -----------------------------------------------------------------------------

UPDATE agents_registry
SET
  metadata = metadata || jsonb_build_object('swap_candidate', 'deepseek-flash', 'model_migration', 'BOOTSTRAP-DEEPSEEK-V4.1-FLASH')
WHERE agent_id = 'cognee-extractor' AND metadata->>'swap_candidate' = 'deepseek-chat';

COMMIT;

-- Verification: surface what changed so the migration runner's log shows it.
SELECT provider_key, model_id, is_active, is_recommended, tier
FROM llm_allowed_models
WHERE provider_key = 'deepseek'
ORDER BY model_id;
