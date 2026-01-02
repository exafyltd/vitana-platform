/**
 * VTID-01126: Situational Awareness Engine Routes (D32)
 *
 * Endpoints for the D32 Situational Awareness Engine.
 * Provides situation computation, action scoring, override, and debug capabilities.
 *
 * Endpoints:
 * - POST /api/v1/situational/compute   - Compute situational awareness bundle
 * - POST /api/v1/situational/score     - Score actions against situation
 * - POST /api/v1/situational/override  - Override situational inference
 * - GET  /api/v1/situational/debug     - Debug last situational decision
 * - GET  /api/v1/situational/health    - Health check
 * - GET  /api/v1/situational/config    - Get current configuration
 *
 * Position in Intelligence Stack:
 * D20 Context -> D21 Intent -> D22 Routing -> D27 Preferences -> D28 Signals -> D32 Situational
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  computeSituationalAwareness,
  scoreActions,
  overrideSituation,
  verifyBundleIntegrity,
  VTID,
  ENGINE_VERSION,
  DEFAULT_SITUATIONAL_CONFIG
} from '../services/d32-situational-awareness-engine';
import {
  SituationalAwarenessBundle,
  SituationalAwarenessInput,
  TimeWindow,
  DayType,
  AvailabilityLevel,
  EnergyLevel,
  SituationalConstraintType,
  SituationTag,
  TIME_WINDOW_RANGES,
  DEFAULT_ENERGY_BY_TIME,
  DEFAULT_READINESS_BY_TIME
} from '../types/situational-awareness';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// VTID-01126: Request Validation Schemas
// =============================================================================

/**
 * Schema for full situational awareness input
 */
const SituationalInputSchema = z.object({
  user_id: z.string().uuid().optional().default('00000000-0000-0000-0000-000000000099'),
  tenant_id: z.string().uuid().optional().default('00000000-0000-0000-0000-000000000001'),
  session_id: z.string().optional(),
  current_message: z.string().optional(),
  context_bundle_id: z.string().optional(),
  intent: z.object({
    primary_intent: z.string().optional(),
    urgency_level: z.string().optional()
  }).optional(),
  emotional_cognitive_signals: z.object({
    emotional_state: z.string().optional(),
    cognitive_state: z.string().optional(),
    engagement_level: z.string().optional(),
    is_urgent: z.boolean().optional()
  }).optional(),
  preferences: z.object({
    communication_style: z.string().optional(),
    autonomy_preference: z.string().optional(),
    timing_constraints: z.array(z.object({
      type: z.string(),
      value: z.unknown()
    })).optional()
  }).optional(),
  health_context: z.object({
    energy_level: z.number().min(0).max(100).optional(),
    sleep_quality: z.number().min(0).max(100).optional(),
    stress_level: z.number().min(0).max(100).optional()
  }).optional(),
  calendar_hints: z.object({
    next_event_in_minutes: z.number().optional(),
    is_free_now: z.boolean().optional(),
    busy_until: z.string().optional()
  }).optional(),
  location_hints: z.object({
    city: z.string().optional(),
    country: z.string().optional(),
    is_home: z.boolean().optional(),
    is_traveling: z.boolean().optional()
  }).optional(),
  timezone: z.string().optional(),
  explicit_availability: z.enum(['free', 'lightly_busy', 'busy', 'very_busy', 'do_not_disturb', 'unknown']).optional(),
  explicit_constraints: z.array(z.enum([
    'safety', 'cost_sensitivity', 'mobility_limit', 'privacy_sensitive',
    'time_pressure', 'quiet_mode', 'focus_mode', 'health_constraint'
  ])).optional()
});

/**
 * Schema for action scoring request
 */
const ActionScoringSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    action_type: z.string(),
    domain: z.string().optional()
  })).min(1, 'At least one action is required'),
  situational_input: SituationalInputSchema
});

/**
 * Schema for situation override request
 */
const SituationOverrideSchema = z.object({
  user_id: z.string().uuid(),
  tenant_id: z.string().uuid().optional().default('00000000-0000-0000-0000-000000000001'),
  overrides: z.object({
    availability_level: z.enum(['free', 'lightly_busy', 'busy', 'very_busy', 'do_not_disturb', 'unknown']).optional(),
    energy_level: z.enum(['high', 'moderate', 'low', 'depleted', 'unknown']).optional(),
    constraints: z.array(z.enum([
      'safety', 'cost_sensitivity', 'mobility_limit', 'privacy_sensitive',
      'time_pressure', 'quiet_mode', 'focus_mode', 'health_constraint'
    ])).optional(),
    clear_constraints: z.boolean().optional()
  })
});

/**
 * Schema for quick situation check
 */
const QuickSituationSchema = z.object({
  user_id: z.string().uuid().optional().default('00000000-0000-0000-0000-000000000099'),
  tenant_id: z.string().uuid().optional().default('00000000-0000-0000-0000-000000000001'),
  timezone: z.string().optional()
});

// =============================================================================
// VTID-01126: In-Memory Debug Cache
// =============================================================================

/**
 * Simple in-memory cache for last situational decision (dev/debug only)
 */
interface DebugCacheEntry {
  input: SituationalAwarenessInput;
  bundle: SituationalAwarenessBundle;
  timestamp: string;
}

const debugCache = new Map<string, DebugCacheEntry>();
const MAX_DEBUG_CACHE_SIZE = 100;

function cacheDebugEntry(userId: string, input: SituationalAwarenessInput, bundle: SituationalAwarenessBundle): void {
  // Evict oldest entries if cache is full
  if (debugCache.size >= MAX_DEBUG_CACHE_SIZE) {
    const oldestKey = debugCache.keys().next().value;
    if (oldestKey) debugCache.delete(oldestKey);
  }

  debugCache.set(userId, {
    input,
    bundle,
    timestamp: new Date().toISOString()
  });
}

// =============================================================================
// VTID-01126: Routes
// =============================================================================

/**
 * POST /compute -> POST /api/v1/situational/compute
 *
 * Compute full situational awareness bundle from all available inputs.
 * This is the main entry point for situational awareness.
 */
router.post('/compute', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /situational/compute`);

  // Validate request body
  const validation = SituationalInputSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const input = validation.data as SituationalAwarenessInput;

  try {
    // Compute situational awareness
    const result = await computeSituationalAwareness(input);

    if (!result.ok || !result.bundle) {
      return res.status(500).json({
        ok: false,
        error: result.error || 'Computation failed'
      });
    }

    // Cache for debug endpoint
    cacheDebugEntry(input.user_id, input, result.bundle);

    console.log(`[${VTID}] Computed bundle ${result.bundle.bundle_id} (confidence: ${result.bundle.situation_vector.overall_confidence}%)`);

    return res.status(200).json({
      ok: true,
      bundle: result.bundle,
      summary: {
        bundle_id: result.bundle.bundle_id,
        confidence: result.bundle.situation_vector.overall_confidence,
        time_window: result.bundle.situation_vector.time_context.time_window,
        availability: result.bundle.situation_vector.availability_context.availability_level,
        energy: result.bundle.situation_vector.readiness_context.energy_level,
        active_tags: result.bundle.action_envelope.active_tags,
        allowed_action_count: result.bundle.action_envelope.allowed_actions.length,
        blocked_action_count: result.bundle.action_envelope.blocked_actions.length
      }
    });
  } catch (err: any) {
    console.error(`[${VTID}] Computation error:`, err.message);

    await emitOasisEvent({
      vtid: VTID,
      type: 'd32.route.compute.error' as any,
      source: 'situational-awareness-routes',
      status: 'error',
      message: `Situational awareness computation failed: ${err.message}`,
      payload: { error: err.message }
    }).catch(() => {});

    return res.status(500).json({
      ok: false,
      error: 'Situational awareness computation failed',
      message: err.message
    });
  }
});

/**
 * POST /quick -> POST /api/v1/situational/quick
 *
 * Quick situational check with minimal input.
 * Returns basic situation tags for fast decisions.
 */
router.post('/quick', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /situational/quick`);

  // Validate request body
  const validation = QuickSituationSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { user_id, tenant_id, timezone } = validation.data;

  try {
    const result = await computeSituationalAwareness({
      user_id,
      tenant_id,
      timezone
    });

    if (!result.ok || !result.bundle) {
      return res.status(500).json({
        ok: false,
        error: result.error || 'Quick check failed'
      });
    }

    console.log(`[${VTID}] Quick check: ${result.bundle.action_envelope.active_tags.join(', ')}`);

    return res.status(200).json({
      ok: true,
      time_window: result.bundle.situation_vector.time_context.time_window,
      is_late_night: result.bundle.situation_vector.time_context.is_late_night,
      availability: result.bundle.situation_vector.availability_context.availability_level,
      energy: result.bundle.situation_vector.readiness_context.energy_level,
      active_tags: result.bundle.action_envelope.active_tags,
      confidence: result.bundle.situation_vector.overall_confidence,
      bundle_id: result.bundle.bundle_id
    });
  } catch (err: any) {
    console.error(`[${VTID}] Quick check error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'Quick situation check failed',
      message: err.message
    });
  }
});

/**
 * POST /score -> POST /api/v1/situational/score
 *
 * Score a list of actions against the current situation.
 * Returns appropriateness classification for each action.
 */
router.post('/score', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /situational/score`);

  // Validate request body
  const validation = ActionScoringSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { actions, situational_input } = validation.data;

  try {
    const result = await scoreActions(actions, situational_input as SituationalAwarenessInput);

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.error || 'Scoring failed'
      });
    }

    console.log(`[${VTID}] Scored ${actions.length} actions`);

    return res.status(200).json({
      ok: true,
      scored_actions: result.scored_actions,
      situation_summary: result.situation_vector ? {
        confidence: result.situation_vector.overall_confidence,
        time_window: result.situation_vector.time_context.time_window,
        energy: result.situation_vector.readiness_context.energy_level
      } : undefined
    });
  } catch (err: any) {
    console.error(`[${VTID}] Scoring error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'Action scoring failed',
      message: err.message
    });
  }
});

/**
 * POST /override -> POST /api/v1/situational/override
 *
 * Override situational inference with user correction.
 * User corrections immediately override inferred state.
 */
router.post('/override', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /situational/override`);

  // Validate request body
  const validation = SituationOverrideSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { user_id, tenant_id, overrides } = validation.data;

  try {
    const result = await overrideSituation(user_id, tenant_id, overrides);

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.error || 'Override failed'
      });
    }

    console.log(`[${VTID}] Situation overridden for user ${user_id.substring(0, 8)}`);

    return res.status(200).json({
      ok: true,
      message: result.message,
      updated_vector: result.updated_vector ? {
        availability: result.updated_vector.availability_context.availability_level,
        energy: result.updated_vector.readiness_context.energy_level,
        constraint_count: result.updated_vector.constraint_flags.filter(c => c.active).length,
        overall_confidence: result.updated_vector.overall_confidence
      } : undefined
    });
  } catch (err: any) {
    console.error(`[${VTID}] Override error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'Situation override failed',
      message: err.message
    });
  }
});

/**
 * GET /debug -> GET /api/v1/situational/debug
 *
 * Get debug snapshot of last situational decision for a user.
 */
router.get('/debug', (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /situational/debug`);

  const userId = (req.query.user_id as string) || '00000000-0000-0000-0000-000000000099';
  const cached = debugCache.get(userId);

  if (!cached) {
    return res.status(404).json({
      ok: false,
      error: 'No situational decision found for user',
      user_id: userId,
      available_users: Array.from(debugCache.keys()).map(k => k.substring(0, 8) + '...')
    });
  }

  // Verify bundle integrity
  const integrityOk = verifyBundleIntegrity(cached.bundle);

  return res.status(200).json({
    ok: true,
    user_id: userId,
    cached_at: cached.timestamp,
    integrity_verified: integrityOk,
    bundle_summary: {
      bundle_id: cached.bundle.bundle_id,
      bundle_hash: cached.bundle.bundle_hash,
      computed_at: cached.bundle.computed_at,
      duration_ms: cached.bundle.computation_duration_ms
    },
    situation_vector: cached.bundle.situation_vector,
    action_envelope: cached.bundle.action_envelope,
    sources_used: cached.bundle.sources,
    metadata: cached.bundle.metadata
  });
});

/**
 * GET /config -> GET /api/v1/situational/config
 *
 * Get current situational awareness configuration.
 */
router.get('/config', (_req: Request, res: Response) => {
  console.log(`[${VTID}] GET /situational/config`);

  return res.status(200).json({
    ok: true,
    vtid: VTID,
    version: ENGINE_VERSION,
    config: DEFAULT_SITUATIONAL_CONFIG,
    time_windows: Object.entries(TIME_WINDOW_RANGES).map(([window, range]) => ({
      window,
      start_hour: range.start,
      end_hour: range.end,
      default_energy: DEFAULT_ENERGY_BY_TIME[window as TimeWindow],
      default_readiness: DEFAULT_READINESS_BY_TIME[window as TimeWindow]
    })),
    available_tags: [
      'now_ok', 'suggest_short', 'defer_recommendation', 'explore_light',
      'avoid_heavy_decisions', 'focus_mode', 'quiet_hours', 'high_engagement_ok',
      'commerce_ok', 'commerce_deferred', 'booking_ok', 'booking_deferred'
    ],
    available_constraints: [
      'safety', 'cost_sensitivity', 'mobility_limit', 'privacy_sensitive',
      'time_pressure', 'quiet_mode', 'focus_mode', 'health_constraint'
    ]
  });
});

/**
 * GET /health -> GET /api/v1/situational/health
 *
 * Health check for situational awareness system.
 */
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    status: 'ok',
    service: 'situational-awareness',
    vtid: VTID,
    version: ENGINE_VERSION,
    timestamp: new Date().toISOString(),
    capabilities: {
      situational_awareness: true,
      action_scoring: true,
      user_override: true,
      debug: true
    },
    stack_position: 'D32',
    dependencies: {
      upstream: ['D20 Context', 'D21 Intent', 'D22 Routing', 'D27 Preferences', 'D28 Signals'],
      downstream: ['D33-D36 Deep Context', 'D44+ Proactive Intelligence', 'D52+ Autopilot']
    },
    behavioral_rules: [
      'Never assume availability if unknown',
      'Prefer light suggestions when uncertainty is high',
      'Defer monetization if situation confidence < threshold',
      'Respect safety, health, and privacy constraints by default',
      'Situational inference must be reversible'
    ]
  });
});

/**
 * GET /tags -> GET /api/v1/situational/tags
 *
 * Get all available situation tags with descriptions.
 */
router.get('/tags', (_req: Request, res: Response) => {
  console.log(`[${VTID}] GET /situational/tags`);

  const tags = [
    { tag: 'now_ok', description: 'Safe to take action now', category: 'timing' },
    { tag: 'suggest_short', description: 'Prefer short/light interactions', category: 'interaction' },
    { tag: 'defer_recommendation', description: 'Hold off on recommendations', category: 'timing' },
    { tag: 'explore_light', description: 'User can browse but dont push', category: 'interaction' },
    { tag: 'avoid_heavy_decisions', description: 'No major decisions right now', category: 'decision' },
    { tag: 'focus_mode', description: 'User is concentrating', category: 'mode' },
    { tag: 'quiet_hours', description: 'Minimal disturbance', category: 'mode' },
    { tag: 'high_engagement_ok', description: 'User is ready for deep engagement', category: 'engagement' },
    { tag: 'commerce_ok', description: 'Commerce recommendations allowed', category: 'commerce' },
    { tag: 'commerce_deferred', description: 'Defer monetization', category: 'commerce' },
    { tag: 'booking_ok', description: 'Booking flows allowed', category: 'booking' },
    { tag: 'booking_deferred', description: 'Defer booking flows', category: 'booking' }
  ];

  return res.status(200).json({
    ok: true,
    tags,
    count: tags.length,
    categories: ['timing', 'interaction', 'decision', 'mode', 'engagement', 'commerce', 'booking']
  });
});

/**
 * POST /validate -> POST /api/v1/situational/validate
 *
 * Validate that a situation allows specific operations.
 */
router.post('/validate', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /situational/validate`);

  const { situational_input, operations } = req.body;

  if (!situational_input || !operations || !Array.isArray(operations)) {
    return res.status(400).json({
      ok: false,
      error: 'situational_input and operations[] are required'
    });
  }

  try {
    const result = await computeSituationalAwareness(situational_input);

    if (!result.ok || !result.bundle) {
      return res.status(500).json({
        ok: false,
        error: result.error || 'Validation computation failed'
      });
    }

    const tags = result.bundle.action_envelope.active_tags;
    const validationResults: Record<string, { allowed: boolean; reason: string }> = {};

    for (const operation of operations) {
      switch (operation) {
        case 'commerce':
          validationResults[operation] = {
            allowed: tags.includes('commerce_ok'),
            reason: tags.includes('commerce_ok') ?
              'Commerce allowed based on situation' :
              'Commerce deferred - situation confidence or timing insufficient'
          };
          break;
        case 'booking':
          validationResults[operation] = {
            allowed: tags.includes('booking_ok'),
            reason: tags.includes('booking_ok') ?
              'Booking allowed based on availability' :
              'Booking deferred - user availability or readiness insufficient'
          };
          break;
        case 'notification':
          validationResults[operation] = {
            allowed: !tags.includes('quiet_hours'),
            reason: !tags.includes('quiet_hours') ?
              'Notifications allowed' :
              'Notifications blocked - quiet hours active'
          };
          break;
        case 'deep_engagement':
          validationResults[operation] = {
            allowed: tags.includes('high_engagement_ok'),
            reason: tags.includes('high_engagement_ok') ?
              'Deep engagement allowed' :
              'Prefer lighter engagement in current situation'
          };
          break;
        case 'proactive_action':
          validationResults[operation] = {
            allowed: tags.includes('now_ok') && !tags.includes('defer_recommendation'),
            reason: tags.includes('now_ok') && !tags.includes('defer_recommendation') ?
              'Proactive actions allowed' :
              'Defer proactive actions - timing or confidence insufficient'
          };
          break;
        default:
          validationResults[operation] = {
            allowed: tags.includes('now_ok'),
            reason: 'General validation based on situation'
          };
      }
    }

    const allAllowed = Object.values(validationResults).every(v => v.allowed);

    return res.status(200).json({
      ok: true,
      all_allowed: allAllowed,
      results: validationResults,
      situation_confidence: result.bundle.situation_vector.overall_confidence,
      active_tags: tags
    });
  } catch (err: any) {
    console.error(`[${VTID}] Validation error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'Validation failed',
      message: err.message
    });
  }
});

export default router;
