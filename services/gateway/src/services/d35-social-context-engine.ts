/**
 * VTID-01129: D35 Social Context, Relationship Weighting & Proximity Engine
 *
 * Deterministic engine that understands who matters right now in the user's life
 * and how social context should shape recommendations.
 *
 * D35 ensures the system reasons about:
 * - Personal relationships
 * - Social proximity
 * - Group relevance
 * - Social comfort & trust
 *
 * Hard Constraints (from spec):
 * - Never force introductions
 * - Respect explicit social boundaries immediately
 * - Avoid monetization through social pressure
 * - Gradually expand social graph unless user opts out
 *
 * Determinism Rules:
 * - Same inputs → same context output
 * - No generative interpretation
 * - Rule-based filtering only
 *
 * Dependencies: D20-D34
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import {
  SocialContextBundle,
  SocialComfortProfile,
  SocialProximityScore,
  SocialContextTag,
  ActiveRelationshipSet,
  SociallyWeightedAction,
  ComputeSocialContextRequest,
  ComputeSocialContextResponse,
  GetProximityScoreRequest,
  GetProximityScoreResponse,
  UpdateComfortProfileRequest,
  UpdateComfortProfileResponse,
  GetComfortProfileResponse,
  DEFAULT_SOCIAL_COMFORT_PROFILE,
  DEFAULT_ACTIVE_RELATIONSHIP_SET,
  SOCIAL_FILTERING_RULES,
  deriveContextTags,
  calculateProximityScore,
  generateSocialContextHash,
  isComfortAcceptable,
  inferRelationshipTier,
  RelationshipTier,
  ActionSocialContext,
  ComfortLevel
} from '../types/social-context';

// =============================================================================
// Constants
// =============================================================================

const VTID = 'VTID-01129';
const LOG_PREFIX = '[D35-Engine]';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

// =============================================================================
// Environment Detection
// =============================================================================

function isDevSandbox(): boolean {
  const env = (process.env.ENVIRONMENT || process.env.VITANA_ENV || '').toLowerCase();
  return env === 'dev-sandbox' ||
         env === 'dev' ||
         env === 'development' ||
         env === 'sandbox' ||
         env.includes('dev') ||
         env.includes('sandbox');
}

// =============================================================================
// Supabase Client
// =============================================================================

function createServiceClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn(`${LOG_PREFIX} Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

function createUserClient(token: string): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn(`${LOG_PREFIX} Missing SUPABASE_URL or SUPABASE_ANON_KEY`);
    return null;
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

// =============================================================================
// Helper: Bootstrap Dev Context
// =============================================================================

async function bootstrapDevContext(supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase.rpc('dev_bootstrap_request_context', {
    p_tenant_id: DEV_IDENTITY.TENANT_ID,
    p_active_role: 'developer'
  });
  if (error) {
    console.warn(`${LOG_PREFIX} Bootstrap context failed (non-fatal):`, error.message);
  }
}

// =============================================================================
// D35 Engine Core Functions
// =============================================================================

/**
 * Get user's social comfort profile
 *
 * @param authToken - JWT token for authenticated requests
 * @returns Comfort profile response
 */
export async function getComfortProfile(
  authToken?: string
): Promise<GetComfortProfileResponse> {
  try {
    let supabase: SupabaseClient | null;
    let useDevIdentity = false;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
      useDevIdentity = true;
    } else {
      return {
        ok: false,
        error: 'UNAUTHENTICATED',
        message: 'Authentication required for comfort profile access'
      };
    }

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to database'
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    const result = await supabase.rpc('social_get_comfort_profile');

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error:`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const data = result.data as { ok: boolean; profile?: SocialComfortProfile; error?: string; message?: string };

    if (!data.ok) {
      return {
        ok: false,
        error: data.error,
        message: data.message
      };
    }

    return {
      ok: true,
      profile: data.profile
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting comfort profile:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Update user's social comfort profile
 *
 * @param request - Update request with field, value, and source
 * @param authToken - JWT token for authenticated requests
 * @returns Updated comfort profile
 */
export async function updateComfortProfile(
  request: UpdateComfortProfileRequest,
  authToken?: string
): Promise<UpdateComfortProfileResponse> {
  try {
    let supabase: SupabaseClient | null;
    let useDevIdentity = false;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
      useDevIdentity = true;
    } else {
      return {
        ok: false,
        error: 'UNAUTHENTICATED',
        message: 'Authentication required'
      };
    }

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to database'
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    const value = typeof request.value === 'number' ? request.value.toString() : request.value;

    const result = await supabase.rpc('social_update_comfort_profile', {
      p_field: request.field,
      p_value: value,
      p_source: request.source
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error:`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const data = result.data as { ok: boolean; profile?: SocialComfortProfile; error?: string; message?: string };

    if (!data.ok) {
      return {
        ok: false,
        error: data.error,
        message: data.message
      };
    }

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: 'd35.comfort.updated',
      source: 'gateway-d35',
      status: 'success',
      message: `Comfort profile field '${request.field}' updated`,
      payload: {
        field: request.field,
        value: request.value,
        source: request.source
      }
    });

    console.log(`${LOG_PREFIX} Comfort profile updated: ${request.field}=${request.value}`);

    return {
      ok: true,
      profile: data.profile
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error updating comfort profile:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Compute social proximity score for a connection
 *
 * @param request - Node ID and optional context
 * @param authToken - JWT token for authenticated requests
 * @returns Proximity score
 */
export async function computeProximityScore(
  request: GetProximityScoreRequest,
  authToken?: string
): Promise<GetProximityScoreResponse> {
  try {
    let supabase: SupabaseClient | null;
    let useDevIdentity = false;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
      useDevIdentity = true;
    } else {
      return {
        ok: false,
        error: 'UNAUTHENTICATED',
        message: 'Authentication required'
      };
    }

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to database'
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    const result = await supabase.rpc('social_compute_proximity', {
      p_node_id: request.node_id,
      p_context_domain: request.context_domain || null
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error:`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const data = result.data as {
      ok: boolean;
      cached?: boolean;
      score?: SocialProximityScore;
      error?: string;
      message?: string;
    };

    if (!data.ok) {
      return {
        ok: false,
        error: data.error,
        message: data.message
      };
    }

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: 'd35.proximity.scored',
      source: 'gateway-d35',
      status: 'success',
      message: `Proximity score computed for node ${request.node_id}`,
      payload: {
        node_id: request.node_id,
        score: data.score?.score,
        tier: data.score?.tier,
        cached: data.cached
      }
    });

    return {
      ok: true,
      score: data.score
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error computing proximity:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Compute full social context bundle
 *
 * This is the main entry point for D35 context computation.
 * Returns everything needed for socially-aware recommendations.
 *
 * @param request - Context computation parameters
 * @param authToken - JWT token for authenticated requests
 * @returns Complete social context bundle
 */
export async function computeSocialContext(
  request: ComputeSocialContextRequest,
  authToken?: string
): Promise<ComputeSocialContextResponse> {
  const startTime = Date.now();

  try {
    let supabase: SupabaseClient | null;
    let useDevIdentity = false;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
      useDevIdentity = true;
    } else {
      return {
        ok: false,
        error: 'UNAUTHENTICATED',
        message: 'Authentication required for social context computation'
      };
    }

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to database'
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    const result = await supabase.rpc('social_compute_context', {
      p_domain: request.domain || null,
      p_intent_type: request.intent_type || null,
      p_emotional_state: request.emotional_state || null,
      p_social_intent: request.social_intent || false,
      p_max_connections: request.max_connections || 10
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error:`, result.error);

      await emitOasisEvent({
        vtid: VTID,
        type: 'd35.context.compute.failed',
        source: 'gateway-d35',
        status: 'error',
        message: `Social context computation failed: ${result.error.message}`,
        payload: {
          error: result.error.message,
          domain: request.domain
        }
      });

      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const data = result.data as {
      ok: boolean;
      bundle?: SocialContextBundle;
      error?: string;
      message?: string;
    };

    if (!data.ok) {
      return {
        ok: false,
        error: data.error,
        message: data.message
      };
    }

    const duration = Date.now() - startTime;

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: 'd35.context.computed',
      source: 'gateway-d35',
      status: 'success',
      message: `Social context computed in ${duration}ms`,
      payload: {
        bundle_id: data.bundle?.metadata.bundle_id,
        domain: request.domain,
        intent_type: request.intent_type,
        tags_count: data.bundle?.context_tags.length || 0,
        connections_count: data.bundle?.relevant_connections.length || 0,
        duration_ms: duration
      }
    });

    console.log(`${LOG_PREFIX} Computed social context in ${duration}ms, tags=${data.bundle?.context_tags.length || 0}`);

    return {
      ok: true,
      bundle: data.bundle,
      processing_time_ms: duration
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error computing social context:`, errorMessage);

    await emitOasisEvent({
      vtid: VTID,
      type: 'd35.context.compute.failed',
      source: 'gateway-d35',
      status: 'error',
      message: `Social context computation error: ${errorMessage}`,
      payload: { error: errorMessage }
    });

    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Invalidate cached proximity scores
 *
 * Call this when relationship data changes to ensure fresh scores.
 *
 * @param nodeId - Optional specific node to invalidate (null = all)
 * @param authToken - JWT token for authenticated requests
 * @returns Invalidation result
 */
export async function invalidateProximityCache(
  nodeId?: string,
  authToken?: string
): Promise<{ ok: boolean; deleted_count?: number; error?: string; message?: string }> {
  try {
    let supabase: SupabaseClient | null;
    let useDevIdentity = false;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
      useDevIdentity = true;
    } else {
      return {
        ok: false,
        error: 'UNAUTHENTICATED',
        message: 'Authentication required'
      };
    }

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to database'
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    const result = await supabase.rpc('social_invalidate_cache', {
      p_node_id: nodeId || null
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error:`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const data = result.data as { ok: boolean; deleted_count: number };
    console.log(`${LOG_PREFIX} Cache invalidated: ${data.deleted_count} entries`);

    return {
      ok: true,
      deleted_count: data.deleted_count
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error invalidating cache:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

// =============================================================================
// Action Filtering Functions
// =============================================================================

/**
 * Filter actions based on social context
 *
 * Applies social filtering rules to a list of potential actions.
 * This is used by recommendation systems to respect social boundaries.
 *
 * @param actions - Potential actions to filter
 * @param profile - User's comfort profile
 * @param contextTags - Active context tags
 * @returns Filtered and weighted actions
 */
export function filterActionsForSocialContext(
  actions: Array<{
    action_id: string;
    action_type: string;
    action_description: string;
    social_context: ActionSocialContext;
  }>,
  profile: SocialComfortProfile,
  contextTags: SocialContextTag[]
): SociallyWeightedAction[] {
  const filteredActions: SociallyWeightedAction[] = [];

  for (const action of actions) {
    let comfortFit = 100;
    const appliedTags: SocialContextTag[] = [];
    const rationale: string[] = [];

    // Check group size comfort
    const maxGroupSize = action.social_context.group_size.max;
    if (maxGroupSize === 1) {
      // One-on-one
      if (profile.one_to_one === 'comfortable') {
        comfortFit = Math.min(comfortFit, 100);
        appliedTags.push('one_on_one_preferred');
      } else if (profile.one_to_one === 'uncomfortable') {
        comfortFit = Math.min(comfortFit, 20);
        rationale.push('User uncomfortable with 1:1 interactions');
      }
    } else if (maxGroupSize <= 6) {
      // Small group
      if (profile.small_group === 'comfortable') {
        comfortFit = Math.min(comfortFit, 90);
        appliedTags.push('small_group_only');
      } else if (profile.small_group === 'uncomfortable') {
        comfortFit = Math.min(comfortFit, 30);
        rationale.push('User uncomfortable with small groups');
      }
    } else {
      // Large group
      if (profile.large_group === 'comfortable') {
        comfortFit = Math.min(comfortFit, 80);
        appliedTags.push('large_group_ok');
      } else if (profile.large_group === 'uncomfortable') {
        comfortFit = Math.min(comfortFit, 10);
        appliedTags.push('small_group_only');
        rationale.push('User uncomfortable with large groups');
      } else if (profile.large_group === 'unknown') {
        comfortFit = Math.min(comfortFit, 50);
        rationale.push('User comfort with large groups unknown');
      }
    }

    // Check new people comfort
    if (action.social_context.involves_new_people) {
      if (profile.new_people === 'comfortable') {
        comfortFit = Math.min(comfortFit, comfortFit);
        appliedTags.push('social_expansion_ok');
      } else if (profile.new_people === 'uncomfortable') {
        comfortFit = Math.min(comfortFit, 15);
        appliedTags.push('avoid_new_connections');
        appliedTags.push('prefer_known_people');
        rationale.push('User uncomfortable with new people');
      } else if (profile.new_people === 'unknown') {
        comfortFit = Math.min(comfortFit, 40);
        rationale.push('User comfort with new people unknown');
      }
    } else {
      appliedTags.push('prefer_known_people');
    }

    // Apply social energy factor
    if (profile.social_energy < 30) {
      comfortFit = Math.min(comfortFit, comfortFit * 0.7);
      appliedTags.push('low_energy_mode');
      rationale.push('User has low social energy');
    } else if (profile.social_energy >= 70) {
      comfortFit = Math.min(100, comfortFit * 1.1);
      appliedTags.push('high_energy_mode');
    }

    // Apply filtering rules
    for (const rule of SOCIAL_FILTERING_RULES) {
      let ruleApplies = false;

      if (rule.condition.social_energy_max !== undefined && profile.social_energy <= rule.condition.social_energy_max) {
        ruleApplies = true;
      }
      if (rule.condition.social_energy_min !== undefined && profile.social_energy >= rule.condition.social_energy_min) {
        ruleApplies = true;
      }
      if (rule.condition.comfort_field && rule.condition.comfort_value) {
        const fieldValue = profile[rule.condition.comfort_field] as ComfortLevel;
        if (fieldValue === rule.condition.comfort_value) {
          ruleApplies = true;
        }
      }

      if (ruleApplies) {
        if (rule.action.max_group_size && maxGroupSize > rule.action.max_group_size) {
          comfortFit = Math.min(comfortFit, 20);
          rationale.push(`Rule '${rule.name}': group too large`);
        }
        if (rule.action.avoid_new_people && action.social_context.involves_new_people) {
          comfortFit = Math.min(comfortFit, 15);
          rationale.push(`Rule '${rule.name}': avoid new people`);
        }
        if (rule.action.require_tags) {
          for (const tag of rule.action.require_tags) {
            if (!appliedTags.includes(tag)) {
              appliedTags.push(tag);
            }
          }
        }
        if (rule.action.exclude_tags) {
          for (const tag of rule.action.exclude_tags) {
            const idx = appliedTags.indexOf(tag);
            if (idx >= 0) {
              appliedTags.splice(idx, 1);
            }
          }
        }
      }
    }

    // Build weighted action
    const weightedAction: SociallyWeightedAction = {
      action_id: action.action_id,
      action_type: action.action_type,
      action_description: action.action_description,
      social_context: action.social_context,
      proximity_score: null,
      comfort_fit: Math.round(Math.max(0, Math.min(100, comfortFit))),
      tags: [...new Set(appliedTags)],
      rationale: rationale.length > 0 ? rationale.join('; ') : 'Action fits comfort profile'
    };

    // Only include actions with non-zero comfort fit
    if (weightedAction.comfort_fit > 0) {
      filteredActions.push(weightedAction);
    }
  }

  // Sort by comfort fit descending
  filteredActions.sort((a, b) => b.comfort_fit - a.comfort_fit);

  return filteredActions;
}

/**
 * Check if an action respects social boundaries
 *
 * Quick check for whether an action should be blocked based on hard boundaries.
 *
 * @param action - Action to check
 * @param profile - User's comfort profile
 * @returns Whether action respects boundaries
 */
export function respectsSocialBoundaries(
  action: { social_context: ActionSocialContext },
  profile: SocialComfortProfile
): { allowed: boolean; reason?: string } {
  // Hard boundary: uncomfortable with new people + action involves new people
  if (action.social_context.involves_new_people &&
      profile.new_people === 'uncomfortable' &&
      profile.new_people_confidence >= 70) {
    return {
      allowed: false,
      reason: 'User has explicitly indicated discomfort with meeting new people'
    };
  }

  // Hard boundary: uncomfortable with large groups + large group action
  if (action.social_context.group_size.max > 6 &&
      profile.large_group === 'uncomfortable' &&
      profile.large_group_confidence >= 70) {
    return {
      allowed: false,
      reason: 'User has explicitly indicated discomfort with large groups'
    };
  }

  // Hard boundary: very low social energy
  if (profile.social_energy < 10) {
    return {
      allowed: false,
      reason: 'User has very low social energy'
    };
  }

  return { allowed: true };
}

// =============================================================================
// ORB Integration Functions
// =============================================================================

/**
 * Get social context for ORB system prompt injection
 *
 * Returns a formatted string for including in the ORB system prompt
 * to make responses socially aware.
 *
 * @param request - Context computation parameters
 * @param authToken - JWT token
 * @returns Formatted context string for prompt injection
 */
export async function getOrbSocialContext(
  request: ComputeSocialContextRequest,
  authToken?: string
): Promise<{ context: string; bundle: SocialContextBundle } | null> {
  try {
    const result = await computeSocialContext(request, authToken);

    if (!result.ok || !result.bundle) {
      return null;
    }

    const bundle = result.bundle;
    const profile = bundle.comfort_profile;
    const tags = bundle.context_tags;

    // Format for prompt injection
    const lines: string[] = [
      '## Social Context (D35)',
      ''
    ];

    // Social energy
    lines.push(`- Social Energy: ${profile.social_energy}/100`);
    if (profile.social_energy < 30) {
      lines.push('  (LOW - prefer low-key, familiar interactions)');
    } else if (profile.social_energy >= 70) {
      lines.push('  (HIGH - open to social activities and expansion)');
    }

    // Comfort indicators
    if (profile.one_to_one === 'comfortable' && profile.one_to_one_confidence >= 60) {
      lines.push('- Comfortable with 1:1 interactions');
    }
    if (profile.large_group === 'uncomfortable' && profile.large_group_confidence >= 50) {
      lines.push('- Prefers smaller groups (avoid large gatherings)');
    }
    if (profile.new_people === 'uncomfortable' && profile.new_people_confidence >= 50) {
      lines.push('- Prefers existing connections (avoid suggesting new introductions)');
    } else if (profile.new_people === 'comfortable' && profile.new_people_confidence >= 60) {
      lines.push('- Open to meeting new people');
    }

    // Active tags
    if (tags.length > 0) {
      lines.push('');
      lines.push('### Active Social Constraints:');
      for (const tag of tags) {
        const formatted = tag.replace(/_/g, ' ');
        lines.push(`- ${formatted}`);
      }
    }

    // Relevant connections summary
    if (bundle.relevant_connections.length > 0) {
      lines.push('');
      lines.push(`### ${bundle.relevant_connections.length} relevant connections available`);
      const tiers = new Map<string, number>();
      for (const conn of bundle.relevant_connections) {
        tiers.set(conn.tier, (tiers.get(conn.tier) || 0) + 1);
      }
      for (const [tier, count] of tiers) {
        lines.push(`- ${tier}: ${count}`);
      }
    }

    return {
      context: lines.join('\n'),
      bundle
    };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error getting ORB social context:`, error);
    return null;
  }
}

// =============================================================================
// Exports
// =============================================================================

export {
  deriveContextTags,
  calculateProximityScore,
  generateSocialContextHash,
  isComfortAcceptable,
  inferRelationshipTier
};

export type {
  SocialContextBundle,
  SocialComfortProfile,
  SocialProximityScore,
  SocialContextTag,
  ActiveRelationshipSet,
  SociallyWeightedAction,
  ComputeSocialContextRequest,
  ComputeSocialContextResponse,
  GetProximityScoreRequest,
  GetProximityScoreResponse,
  UpdateComfortProfileRequest,
  UpdateComfortProfileResponse,
  GetComfortProfileResponse,
  RelationshipTier,
  ActionSocialContext,
  ComfortLevel
};
