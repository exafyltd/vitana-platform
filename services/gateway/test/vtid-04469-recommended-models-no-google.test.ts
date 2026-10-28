/**
 * VTID-04469 — RECOMMENDED_MODELS may only name models the router can serve
 * under the standing provider rules: Bedrock inference profiles (VTID-03563)
 * and DeepSeek. Never Google (decommissioned, CLAUDE.md §1), never the direct
 * Anthropic API (no credit balance), never an OpenAI model (key not provisioned).
 */
import {
  RECOMMENDED_MODELS,
  LLM_SAFE_DEFAULTS,
  isRecommendedModel,
  type LLMStage,
} from '../src/constants/llm-defaults';

const STAGES = Object.keys(LLM_SAFE_DEFAULTS) as LLMStage[];
const ALLOWED = /^(eu|global)\.anthropic\.claude-|^deepseek-/;

describe('VTID-04469 RECOMMENDED_MODELS', () => {
  it('covers every routed stage', () => {
    for (const stage of STAGES) {
      expect(RECOMMENDED_MODELS[stage]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('names only Bedrock inference profiles or DeepSeek models', () => {
    for (const stage of STAGES) {
      for (const model of RECOMMENDED_MODELS[stage]) {
        expect({ stage, model, ok: ALLOWED.test(model) }).toEqual({ stage, model, ok: true });
      }
    }
  });

  it('never names a Google, direct-Anthropic or OpenAI model', () => {
    const all = STAGES.flatMap((s) => RECOMMENDED_MODELS[s]);
    for (const model of all) {
      expect(model).not.toMatch(/gemini|vertex|^claude-|^gpt-|^o\d/);
    }
  });

  it("recommends each stage's own safe-default primary", () => {
    for (const stage of STAGES) {
      expect(isRecommendedModel(stage, LLM_SAFE_DEFAULTS[stage].primary_model)).toBe(true);
    }
  });
});
