/**
 * VTID-01230: Crew Config Loader for Worker-Runner
 *
 * Reads model assignments and contracts from crew_template/crew.yaml
 * (single source of truth). Eliminates hardcoded model strings.
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';

export interface ModelConfig {
  provider: string;
  model_id: string;
  fallback_model_id: string;
}

export interface RoleConfig {
  primary: string;
  fallback: string;
}

export interface ResolvedModelConfig {
  provider: string;
  modelId: string;
  fallbackProvider: string;
  fallbackModelId: string;
}

export interface CrewConfig {
  version: string;
  models: Record<string, ModelConfig>;
  roles: Record<string, RoleConfig>;
}

let _cachedConfig: CrewConfig | null = null;

/**
 * Load crew.yaml from known paths
 */
export function loadCrewConfig(): CrewConfig {
  if (_cachedConfig) return _cachedConfig;

  const searchPaths = [
    // Env override
    process.env.CREW_CONFIG_PATH,
    // Relative to worker-runner/src/services -> repo root
    join(__dirname, '..', '..', '..', '..', 'crew_template', 'crew.yaml'),
    // Docker mount
    '/app/crew_template/crew.yaml',
  ].filter(Boolean) as string[];

  for (const rawPath of searchPaths) {
    const absPath = resolve(rawPath);
    if (existsSync(absPath)) {
      try {
        const raw = readFileSync(absPath, 'utf-8');
        const parsed = parseYaml(raw);
        const policy = parsed?.provider_policy || {};

        _cachedConfig = {
          version: policy.version || '1.0',
          models: policy.models || {},
          roles: policy.roles || {},
        };

        console.log(`[VTID-01230] Loaded crew config from ${absPath} (v${_cachedConfig.version})`);
        return _cachedConfig;
      } catch (err) {
        console.error(`[VTID-01230] Failed to parse crew.yaml at ${absPath}:`, err);
      }
    }
  }

  // Fallback defaults matching crew.yaml v2.0
  console.warn('[VTID-01230] crew.yaml not found, using built-in defaults');
  _cachedConfig = {
    version: 'fallback',
    models: {
      gemini: { provider: 'vertex_ai', model_id: 'gemini-2.5-pro', fallback_model_id: 'gemini-1.5-pro' },
      claude: { provider: 'anthropic', model_id: 'claude-sonnet-4-5-20250929', fallback_model_id: 'claude-3-5-sonnet-20241022' },
    },
    roles: {
      worker: { primary: 'gemini', fallback: 'claude' },
      planner: { primary: 'claude', fallback: 'gemini' },
      validator: { primary: 'claude', fallback: 'gemini' },
    },
  };
  return _cachedConfig;
}

/**
 * Resolve the concrete model for a given role
 */
export function resolveModelForRole(role: string): ResolvedModelConfig {
  const config = loadCrewConfig();
  const roleConfig = config.roles[role] || config.roles['worker'] || { primary: 'gemini', fallback: 'claude' };
  const primaryKey = roleConfig.primary;
  const fallbackKey = roleConfig.fallback;
  const primaryModel = config.models[primaryKey] || config.models['gemini'];
  const fallbackModel = config.models[fallbackKey] || config.models['claude'];

  return {
    provider: primaryModel.provider,
    modelId: primaryModel.model_id,
    fallbackProvider: fallbackModel.provider,
    fallbackModelId: fallbackModel.fallback_model_id || fallbackModel.model_id,
  };
}
