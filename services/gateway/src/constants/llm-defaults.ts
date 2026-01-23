/**
 * VTID-01208: LLM Safe Defaults Constants
 *
 * These are the hardcoded safe defaults for LLM routing.
 * Used when:
 * - "Reset to Recommended" is clicked
 * - Database is unavailable
 * - Policy validation fails
 *
 * IMPORTANT: These defaults cannot be changed via UI.
 * Changes require code review and deployment.
 */

/**
 * LLM Stage types
 */
export type LLMStage = 'planner' | 'worker' | 'validator' | 'operator' | 'memory';

/**
 * LLM Provider types
 */
export type LLMProvider = 'anthropic' | 'vertex' | 'openai';

/**
 * Stage routing configuration
 */
export interface StageRoutingConfig {
  primary_provider: LLMProvider;
  primary_model: string;
  fallback_provider: LLMProvider;
  fallback_model: string;
}

/**
 * Complete LLM routing policy
 */
export interface LLMRoutingPolicy {
  planner: StageRoutingConfig;
  worker: StageRoutingConfig;
  validator: StageRoutingConfig;
  operator: StageRoutingConfig;
  memory: StageRoutingConfig;
}

/**
 * Safe defaults for LLM routing policy
 *
 * Rationale:
 * - Planner: Claude 3.5 Sonnet - Best reasoning for task decomposition
 * - Worker: Gemini 1.5 Flash - Cost-efficient execution
 * - Validator: Claude 3.5 Sonnet - Strict rule-following for governance
 * - Operator: Gemini 2.5 Pro - Multimodal conversational capability
 * - Memory: Claude 3.5 Sonnet - Fact extraction accuracy
 */
export const LLM_SAFE_DEFAULTS: LLMRoutingPolicy = {
  planner: {
    primary_provider: 'anthropic',
    primary_model: 'claude-3-5-sonnet-20241022',
    fallback_provider: 'vertex',
    fallback_model: 'gemini-1.5-pro',
  },
  worker: {
    primary_provider: 'vertex',
    primary_model: 'gemini-1.5-flash',
    fallback_provider: 'vertex',
    fallback_model: 'gemini-1.5-pro',
  },
  validator: {
    primary_provider: 'anthropic',
    primary_model: 'claude-3-5-sonnet-20241022',
    fallback_provider: 'vertex',
    fallback_model: 'gemini-1.5-pro',
  },
  operator: {
    primary_provider: 'vertex',
    primary_model: 'gemini-2.5-pro',
    fallback_provider: 'anthropic',
    fallback_model: 'claude-3-5-sonnet-20241022',
  },
  memory: {
    primary_provider: 'anthropic',
    primary_model: 'claude-3-5-sonnet-20241022',
    fallback_provider: 'vertex',
    fallback_model: 'gemini-1.5-flash',
  },
};

/**
 * Model cost information (USD per 1M tokens)
 * Used for cost estimation in telemetry
 */
export const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },

  // Google Vertex AI
  'gemini-2.5-pro': { input: 1.25, output: 5.00 },
  'gemini-1.5-pro': { input: 1.25, output: 5.00 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },

  // OpenAI (future support)
  'gpt-4o': { input: 5.00, output: 15.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
};

/**
 * Calculate estimated cost for an LLM call
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const costs = MODEL_COSTS[model];
  if (!costs) {
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * costs.input;
  const outputCost = (outputTokens / 1_000_000) * costs.output;

  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // Round to 6 decimal places
}

/**
 * Valid stages for routing
 */
export const VALID_STAGES: LLMStage[] = ['planner', 'worker', 'validator', 'operator', 'memory'];

/**
 * Valid providers
 */
export const VALID_PROVIDERS: LLMProvider[] = ['anthropic', 'vertex', 'openai'];

/**
 * Recommended models per stage (for UI warnings)
 */
export const RECOMMENDED_MODELS: Record<LLMStage, string[]> = {
  planner: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229'],
  worker: ['gemini-1.5-flash', 'gemini-1.5-pro', 'claude-3-haiku-20240307'],
  validator: ['claude-3-5-sonnet-20241022'],
  operator: ['gemini-2.5-pro', 'gemini-1.5-pro'],
  memory: ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
};

/**
 * Check if a model is recommended for a stage
 */
export function isRecommendedModel(stage: LLMStage, model: string): boolean {
  return RECOMMENDED_MODELS[stage]?.includes(model) ?? false;
}

/**
 * Get the default policy for a specific stage
 */
export function getStageDefaults(stage: LLMStage): StageRoutingConfig {
  return LLM_SAFE_DEFAULTS[stage];
}

export default LLM_SAFE_DEFAULTS;
