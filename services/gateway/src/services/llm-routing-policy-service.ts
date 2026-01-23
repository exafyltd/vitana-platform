/**
 * VTID-01208: LLM Routing Policy Service
 *
 * Manages LLM routing policies with:
 * - Governance and audit
 * - VTID policy locking
 * - Provider/model allowlist validation
 * - Safe defaults fallback
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { LLM_SAFE_DEFAULTS, VALID_STAGES, VALID_PROVIDERS } from '../constants/llm-defaults';
import {
  LLMStage,
  LLMProvider,
  LLMRoutingPolicy,
  StageRoutingConfig,
  LLMRoutingPolicyRecord,
  AllowedProvider,
  AllowedModel,
  PolicyAuditRecord,
  VTIDPolicySnapshot,
  UpdatePolicyRequest,
  RoutingPolicyResponse,
} from '../types/llm-telemetry';

/**
 * Get Supabase client config
 */
function getSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;

  if (!url || !key) {
    console.error('[LLM Policy] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
    return null;
  }

  return { url, key };
}

/**
 * Fetch helper for Supabase REST API
 */
async function supabaseFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const config = getSupabaseConfig();
  if (!config) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'apikey': config.key,
      'Authorization': `Bearer ${config.key}`,
    };
    if (options.method === 'POST') {
      headers['Prefer'] = 'return=representation';
    }

    const response = await fetch(`${config.url}/rest/v1/${path}`, {
      ...options,
      headers: {
        ...headers,
        ...(options.headers as Record<string, string>),
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const data = await response.json() as T;
    return { ok: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, error: message };
  }
}

/**
 * Get all allowed providers
 */
export async function getAllowedProviders(): Promise<AllowedProvider[]> {
  const result = await supabaseFetch<AllowedProvider[]>(
    'llm_allowed_providers?is_active=eq.true&order=provider_key'
  );

  if (!result.ok || !result.data) {
    console.warn('[LLM Policy] Failed to fetch providers, using hardcoded list');
    return VALID_PROVIDERS.map(p => ({
      provider_key: p,
      display_name: p.charAt(0).toUpperCase() + p.slice(1),
      is_active: true,
      config: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
  }

  return result.data;
}

/**
 * Get all allowed models
 */
export async function getAllowedModels(): Promise<AllowedModel[]> {
  const result = await supabaseFetch<AllowedModel[]>(
    'llm_allowed_models?is_active=eq.true&order=provider_key,model_id'
  );

  if (!result.ok || !result.data) {
    console.warn('[LLM Policy] Failed to fetch models, returning empty list');
    return [];
  }

  return result.data;
}

/**
 * Get the active routing policy for an environment
 */
export async function getActivePolicy(
  environment: string = 'DEV'
): Promise<LLMRoutingPolicyRecord | null> {
  const result = await supabaseFetch<LLMRoutingPolicyRecord[]>(
    `llm_routing_policy?environment=eq.${environment}&is_active=eq.true&limit=1`
  );

  if (!result.ok || !result.data || result.data.length === 0) {
    console.warn(`[LLM Policy] No active policy found for ${environment}`);
    return null;
  }

  return result.data[0];
}

/**
 * Get the complete routing policy response with allowlists and defaults
 */
export async function getRoutingPolicyResponse(
  environment: string = 'DEV'
): Promise<RoutingPolicyResponse> {
  const [policy, providers, models] = await Promise.all([
    getActivePolicy(environment),
    getAllowedProviders(),
    getAllowedModels(),
  ]);

  return {
    ok: true,
    policy: policy || undefined,
    providers,
    models,
    recommended: LLM_SAFE_DEFAULTS,
  };
}

/**
 * Validate a policy against the allowlist
 */
export async function validatePolicy(
  policy: LLMRoutingPolicy
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  const models = await getAllowedModels();

  const modelMap = new Map<string, AllowedModel>();
  for (const model of models) {
    modelMap.set(`${model.provider_key}/${model.model_id}`, model);
  }

  for (const stage of VALID_STAGES) {
    const config = policy[stage];
    if (!config) {
      errors.push(`Missing configuration for stage: ${stage}`);
      continue;
    }

    // Validate primary
    const primaryKey = `${config.primary_provider}/${config.primary_model}`;
    const primaryModel = modelMap.get(primaryKey);
    if (!primaryModel) {
      errors.push(`Invalid primary model for ${stage}: ${primaryKey}`);
    } else if (!primaryModel.applicable_stages.includes(stage)) {
      errors.push(`Model ${primaryKey} not applicable for stage ${stage}`);
    }

    // Validate fallback
    const fallbackKey = `${config.fallback_provider}/${config.fallback_model}`;
    const fallbackModel = modelMap.get(fallbackKey);
    if (!fallbackModel) {
      errors.push(`Invalid fallback model for ${stage}: ${fallbackKey}`);
    } else if (!fallbackModel.applicable_stages.includes(stage)) {
      errors.push(`Model ${fallbackKey} not applicable for stage ${stage}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Update the routing policy (creates new version, deactivates old)
 */
export async function updateRoutingPolicy(
  request: UpdatePolicyRequest,
  environment: string = 'DEV'
): Promise<{ ok: boolean; policy?: LLMRoutingPolicyRecord; error?: string }> {
  // Validate the new policy
  const validation = await validatePolicy(request.policy);
  if (!validation.valid) {
    return {
      ok: false,
      error: `Policy validation failed: ${validation.errors.join(', ')}`,
    };
  }

  const config = getSupabaseConfig();
  if (!config) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    // Get current active policy
    const currentPolicy = await getActivePolicy(environment);

    // Deactivate current policy if exists
    if (currentPolicy) {
      await supabaseFetch(
        `llm_routing_policy?id=eq.${currentPolicy.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            is_active: false,
            deactivated_at: new Date().toISOString(),
          }),
        }
      );
    }

    // Calculate new version
    const newVersion = (currentPolicy?.version || 0) + 1;

    // Create new policy
    const newPolicyResult = await supabaseFetch<LLMRoutingPolicyRecord[]>(
      'llm_routing_policy',
      {
        method: 'POST',
        body: JSON.stringify({
          environment,
          version: newVersion,
          is_active: true,
          policy: request.policy,
          created_by: request.actor_id,
          activated_at: new Date().toISOString(),
        }),
      }
    );

    if (!newPolicyResult.ok || !newPolicyResult.data || newPolicyResult.data.length === 0) {
      // Rollback: reactivate old policy
      if (currentPolicy) {
        await supabaseFetch(
          `llm_routing_policy?id=eq.${currentPolicy.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              is_active: true,
              deactivated_at: null,
            }),
          }
        );
      }
      return { ok: false, error: `Failed to create new policy: ${newPolicyResult.error}` };
    }

    const newPolicy = newPolicyResult.data[0];

    // Create audit record
    await supabaseFetch('llm_routing_policy_audit', {
      method: 'POST',
      body: JSON.stringify({
        policy_id: newPolicy.id,
        action: 'activated',
        actor_id: request.actor_id,
        actor_role: request.actor_role,
        before_state: currentPolicy?.policy || null,
        after_state: request.policy,
        reason: request.reason,
      }),
    });

    // Emit governance event
    await emitOasisEvent({
      vtid: 'VTID-01208',
      type: 'governance.llm_policy.updated',
      source: 'llm-routing-policy-service',
      status: 'success',
      message: `LLM routing policy updated to v${newVersion}`,
      payload: {
        environment,
        version: newVersion,
        policy_id: newPolicy.id,
        actor_id: request.actor_id,
        actor_role: request.actor_role,
        reason: request.reason,
        changes: Object.keys(request.policy),
        updated_at: new Date().toISOString(),
      },
    });

    console.log(`[LLM Policy] Policy updated: ${environment} v${newVersion}`);

    return { ok: true, policy: newPolicy };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[LLM Policy] Update failed: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * Reset policy to safe defaults
 */
export async function resetToDefaults(
  request: { actor_id: string; actor_role: string; reason?: string },
  environment: string = 'DEV'
): Promise<{ ok: boolean; policy?: LLMRoutingPolicyRecord; error?: string }> {
  const result = await updateRoutingPolicy(
    {
      policy: LLM_SAFE_DEFAULTS,
      actor_id: request.actor_id,
      actor_role: request.actor_role,
      reason: request.reason || 'Reset to recommended defaults',
    },
    environment
  );

  if (result.ok) {
    await emitOasisEvent({
      vtid: 'VTID-01208',
      type: 'governance.llm_policy.reset',
      source: 'llm-routing-policy-service',
      status: 'success',
      message: 'LLM routing policy reset to safe defaults',
      payload: {
        environment,
        actor_id: request.actor_id,
        actor_role: request.actor_role,
        reason: request.reason,
        reset_at: new Date().toISOString(),
      },
    });
  }

  return result;
}

/**
 * Get policy audit history
 */
export async function getPolicyAuditHistory(
  limit: number = 50,
  offset: number = 0
): Promise<{ ok: boolean; records: PolicyAuditRecord[]; error?: string }> {
  const result = await supabaseFetch<PolicyAuditRecord[]>(
    `llm_routing_policy_audit?order=created_at.desc&limit=${limit}&offset=${offset}`
  );

  if (!result.ok) {
    return { ok: false, records: [], error: result.error };
  }

  return { ok: true, records: result.data || [] };
}

/**
 * Get or create VTID policy snapshot (for policy locking)
 */
export async function getOrCreateVTIDPolicySnapshot(
  vtid: string,
  environment: string = 'DEV'
): Promise<{ ok: boolean; snapshot?: VTIDPolicySnapshot; isNew: boolean; error?: string }> {
  const config = getSupabaseConfig();
  if (!config) {
    // Return safe defaults if DB unavailable
    console.warn('[LLM Policy] DB unavailable, using safe defaults for VTID policy');
    return {
      ok: true,
      snapshot: {
        id: randomUUID(),
        vtid,
        policy_version: 0,
        policy_snapshot: LLM_SAFE_DEFAULTS,
        environment,
        created_at: new Date().toISOString(),
      },
      isNew: true,
    };
  }

  // Check for existing snapshot
  const existingResult = await supabaseFetch<VTIDPolicySnapshot[]>(
    `llm_vtid_policy_snapshot?vtid=eq.${vtid}&limit=1`
  );

  if (existingResult.ok && existingResult.data && existingResult.data.length > 0) {
    return { ok: true, snapshot: existingResult.data[0], isNew: false };
  }

  // Get active policy
  const activePolicy = await getActivePolicy(environment);
  const policyToSnapshot = activePolicy?.policy || LLM_SAFE_DEFAULTS;
  const version = activePolicy?.version || 0;

  // Create new snapshot
  const createResult = await supabaseFetch<VTIDPolicySnapshot[]>(
    'llm_vtid_policy_snapshot',
    {
      method: 'POST',
      body: JSON.stringify({
        vtid,
        policy_version: version,
        policy_snapshot: policyToSnapshot,
        environment,
      }),
    }
  );

  if (!createResult.ok || !createResult.data || createResult.data.length === 0) {
    // Return safe defaults on failure
    console.warn(`[LLM Policy] Failed to create snapshot for ${vtid}, using safe defaults`);
    return {
      ok: true,
      snapshot: {
        id: randomUUID(),
        vtid,
        policy_version: version,
        policy_snapshot: policyToSnapshot,
        environment,
        created_at: new Date().toISOString(),
      },
      isNew: true,
    };
  }

  // Emit event for new snapshot
  await emitOasisEvent({
    vtid,
    type: 'vtid.execute.started',
    source: 'llm-routing-policy-service',
    status: 'info',
    message: `Policy v${version} locked for VTID execution`,
    payload: {
      policy_version: version,
      policy_snapshot: policyToSnapshot,
      locked_at: new Date().toISOString(),
    },
  });

  return { ok: true, snapshot: createResult.data[0], isNew: true };
}

/**
 * Get routing config for a specific stage and VTID
 */
export async function getStageRoutingConfig(
  vtid: string | null,
  stage: LLMStage,
  environment: string = 'DEV'
): Promise<StageRoutingConfig> {
  // If VTID provided, use locked policy
  if (vtid) {
    const snapshotResult = await getOrCreateVTIDPolicySnapshot(vtid, environment);
    if (snapshotResult.ok && snapshotResult.snapshot) {
      return snapshotResult.snapshot.policy_snapshot[stage] || LLM_SAFE_DEFAULTS[stage];
    }
  }

  // Otherwise use active policy or safe defaults
  const activePolicy = await getActivePolicy(environment);
  if (activePolicy?.policy) {
    return activePolicy.policy[stage] || LLM_SAFE_DEFAULTS[stage];
  }

  return LLM_SAFE_DEFAULTS[stage];
}

export default {
  getAllowedProviders,
  getAllowedModels,
  getActivePolicy,
  getRoutingPolicyResponse,
  validatePolicy,
  updateRoutingPolicy,
  resetToDefaults,
  getPolicyAuditHistory,
  getOrCreateVTIDPolicySnapshot,
  getStageRoutingConfig,
};
