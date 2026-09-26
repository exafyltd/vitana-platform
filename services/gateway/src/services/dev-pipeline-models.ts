/**
 * VTID-04593: which model the Dev Autopilot pipeline's planner and coding
 * agent run on.
 *
 * Owner decision 2026-09-26: the planner (Dev Autopilot plan generation and
 * the spec generator) runs on DeepSeek Flash; the coding agent (the agent
 * executor, for operator on-ramp runs and the autonomous lane alike) runs on
 * Bedrock Claude Sonnet 4.6. Sonnet 5 was checked the same day: it is listed
 * ACTIVE in `list-inference-profiles` but `invoke_model` answers
 * AccessDeniedException "not available for this account", so it is not used.
 *
 * Each choice replaces the stage's PRIMARY only (VTID-03820 override
 * semantics); the `llm_routing_policy` stage's own fallback still applies on
 * failure. The shared `planner` stage policy is deliberately not changed —
 * member-facing features (shopping agent, goal planner) also read it.
 *
 * Env overrides exist for a controlled experiment. A value naming Google or
 * the direct Anthropic API is refused (CLAUDE.md 10b/27) and the default used.
 */
import type { LLMProvider } from '../constants/llm-defaults';

export interface DevPipelineModel {
  provider: LLMProvider;
  model: string;
}

export const DEV_PLANNER_DEFAULT: DevPipelineModel = { provider: 'deepseek', model: 'deepseek-flash' };
export const DEV_WORKER_DEFAULT: DevPipelineModel = { provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6' };

const REFUSED_PROVIDERS = new Set(['vertex', 'anthropic']);

function resolve(
  providerVar: string,
  modelVar: string,
  fallback: DevPipelineModel,
  env: NodeJS.ProcessEnv,
): DevPipelineModel {
  const provider = (env[providerVar] || '').trim();
  const model = (env[modelVar] || '').trim();
  if (!provider || !model) return fallback;
  if (REFUSED_PROVIDERS.has(provider)) {
    console.warn(`[VTID-04593] ${providerVar}=${provider} refused (no Google, no direct Anthropic API) — using ${fallback.provider}/${fallback.model}`);
    return fallback;
  }
  return { provider: provider as LLMProvider, model };
}

/** The Dev Autopilot planner + spec generator model. */
export function devPlannerModel(env: NodeJS.ProcessEnv = process.env): DevPipelineModel {
  return resolve('DEV_PLANNER_PROVIDER', 'DEV_PLANNER_MODEL', DEV_PLANNER_DEFAULT, env);
}

/** The coding agent's model (agent executor). */
export function devWorkerModel(env: NodeJS.ProcessEnv = process.env): DevPipelineModel {
  return resolve('AGENT_PRIMARY_PROVIDER', 'AGENT_PRIMARY_MODEL', DEV_WORKER_DEFAULT, env);
}
