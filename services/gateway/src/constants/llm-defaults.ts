/**
 * VTID-01208 + BOOTSTRAP-LLM-ROUTER: LLM Safe Defaults Constants
 *
 * Hardcoded safe defaults for LLM routing. Used when:
 * - "Reset to Recommended" is clicked
 * - Database is unavailable
 * - Policy validation fails
 *
 * BOOTSTRAP-LLM-ROUTER (2026-04-26): defaults are now flagship-only — every
 * primary and every fallback is its provider's strongest available model.
 * Operator can step down via the Command Hub dropdown but the system never
 * silently picks a weaker option.
 *
 * Stages extended from {planner|worker|validator|operator|memory} to also
 * include {triage|vision|classifier} so per-call-site routing maps cleanly
 * onto the JSONB policy doc. Providers extended from {anthropic|vertex|openai}
 * to also include {deepseek|claude_subscription}.
 */

/**
 * LLM Stage types
 */
export type LLMStage =
  | 'planner'
  | 'worker'
  | 'validator'
  | 'operator'
  | 'memory'
  | 'triage'
  | 'vision'
  | 'classifier';

/**
 * LLM Provider types
 *
 * `claude_subscription` is the free pseudo-provider that delegates to the
 * local autopilot-worker daemon (`runWorkerTask`) which executes via the
 * user's Claude Pro/Max plan. It only makes sense for the `worker` and
 * `planner` stages — the dropdown should hide it elsewhere.
 */
export type LLMProvider =
  | 'anthropic'
  | 'vertex'
  | 'openai'
  | 'deepseek'
  | 'claude_subscription';

/**
 * Stage routing configuration
 */
export interface StageRoutingConfig {
  primary_provider: LLMProvider;
  primary_model: string;
  fallback_provider: LLMProvider | null;
  fallback_model: string | null;
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
  triage: StageRoutingConfig;
  vision: StageRoutingConfig;
  classifier: StageRoutingConfig;
}

/**
 * Flagship-only safe defaults per the BOOTSTRAP-LLM-ROUTER plan.
 *
 * Every primary AND every fallback is the strongest model the provider
 * exposes. No mid-tier defaults seeded anywhere.
 */
export const LLM_SAFE_DEFAULTS: LLMRoutingPolicy = {
  planner: {
    primary_provider: 'vertex',
    primary_model: 'gemini-3.1-pro-preview',
    fallback_provider: 'anthropic',
    fallback_model: 'claude-opus-4-7',
  },
  worker: {
    primary_provider: 'claude_subscription',
    primary_model: 'claude-opus-4-7',
    fallback_provider: 'vertex',
    fallback_model: 'gemini-3.1-pro-preview',
  },
  validator: {
    primary_provider: 'vertex',
    primary_model: 'gemini-3.1-pro-preview',
    fallback_provider: 'anthropic',
    fallback_model: 'claude-opus-4-7',
  },
  operator: {
    primary_provider: 'vertex',
    primary_model: 'gemini-3.1-pro-preview',
    fallback_provider: 'anthropic',
    fallback_model: 'claude-opus-4-7',
  },
  memory: {
    primary_provider: 'vertex',
    primary_model: 'gemini-3.1-pro-preview',
    fallback_provider: 'deepseek',
    fallback_model: 'deepseek-reasoner',
  },
  triage: {
    primary_provider: 'vertex',
    primary_model: 'gemini-3.1-pro-preview',
    fallback_provider: 'anthropic',
    fallback_model: 'claude-opus-4-7',
  },
  vision: {
    primary_provider: 'vertex',
    primary_model: 'gemini-3.1-pro-preview',
    fallback_provider: 'anthropic',
    fallback_model: 'claude-opus-4-7',
  },
  classifier: {
    primary_provider: 'deepseek',
    primary_model: 'deepseek-reasoner',
    fallback_provider: 'vertex',
    fallback_model: 'gemini-3.1-pro-preview',
  },
};

/**
 * Model cost information (USD per 1M tokens)
 * Used for cost estimation in telemetry
 */
export const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  // Anthropic — flagship + mid + light
  'claude-opus-4-7': { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5': { input: 0.80, output: 4.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },

  // Google Vertex AI — flagship + mid + light
  'gemini-3.1-pro-preview': { input: 1.25, output: 5.00 },
  'gemini-3-pro-preview': { input: 1.25, output: 5.00 },  // legacy alias retained for back-compat
  'gemini-2.5-pro': { input: 1.25, output: 5.00 },        // legacy alias — old policy rows may still reference
  'gemini-2.5-flash': { input: 0.075, output: 0.30 },
  'gemini-1.5-pro': { input: 1.25, output: 5.00 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },

  // OpenAI — flagship + mid + light
  'gpt-5': { input: 5.00, output: 15.00 },                // pricing TBD by OpenAI; using gpt-4o rate as best estimate
  'gpt-4o': { input: 5.00, output: 15.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },

  // DeepSeek — flagship + mid
  'deepseek-reasoner': { input: 0.55, output: 2.19 },     // R1 published rates
  'deepseek-chat': { input: 0.14, output: 0.28 },         // V3 published rates

  // claude_subscription pseudo-provider — billed via Claude Pro/Max plan, not per-token
  'claude-subscription': { input: 0, output: 0 },
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
export const VALID_STAGES: LLMStage[] = [
  'planner',
  'worker',
  'validator',
  'operator',
  'memory',
  'triage',
  'vision',
  'classifier',
];

/**
 * Valid providers
 */
export const VALID_PROVIDERS: LLMProvider[] = [
  'anthropic',
  'vertex',
  'openai',
  'deepseek',
  'claude_subscription',
];

/**
 * Per-provider flagship — looked up by the Command Hub dropdown so flipping
 * providers always lands on the strongest model from the new provider, never
 * on a mid-tier or light option.
 */
export const PROVIDER_FLAGSHIPS: Record<LLMProvider, string> = {
  anthropic: 'claude-opus-4-7',
  vertex: 'gemini-3.1-pro-preview',
  openai: 'gpt-5',
  deepseek: 'deepseek-reasoner',
  claude_subscription: 'claude-opus-4-7',
};

/**
 * Recommended models per stage (for UI warnings)
 */
export const RECOMMENDED_MODELS: Record<LLMStage, string[]> = {
  planner: ['gemini-3.1-pro-preview', 'claude-opus-4-7', 'gpt-5'],
  worker: ['claude-opus-4-7', 'gemini-3.1-pro-preview', 'gpt-5'],
  validator: ['gemini-3.1-pro-preview', 'claude-opus-4-7'],
  operator: ['gemini-3.1-pro-preview', 'claude-opus-4-7'],
  memory: ['gemini-3.1-pro-preview', 'deepseek-reasoner', 'claude-opus-4-7'],
  triage: ['gemini-3.1-pro-preview', 'claude-opus-4-7', 'deepseek-reasoner'],
  vision: ['gemini-3.1-pro-preview', 'claude-opus-4-7'],
  classifier: ['deepseek-reasoner', 'gemini-3.1-pro-preview', 'gpt-5'],
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

/**
 * Get the flagship model id for a provider (used by Command Hub dropdown
 * auto-select when the operator switches providers).
 */
export function getProviderFlagship(provider: LLMProvider): string {
  return PROVIDER_FLAGSHIPS[provider];
}

export default LLM_SAFE_DEFAULTS;
