/**
 * VTID-01114: Domain & Topic Routing Engine Routes
 *
 * Endpoints for the D22 Domain Routing Engine.
 * Provides routing computation, debug, and audit capabilities.
 *
 * Endpoints:
 * - POST /api/v1/routing/compute    - Compute routing bundle from input
 * - POST /api/v1/routing/quick      - Quick routing from message only
 * - GET  /api/v1/routing/debug      - Debug last routing decision
 * - GET  /api/v1/routing/health     - Health check
 * - GET  /api/v1/routing/domains    - List all supported domains
 * - GET  /api/v1/routing/config     - Get current routing configuration
 *
 * Position in Intelligence Stack:
 * D20 Context -> D21 Intent -> D22 Domain Routing -> D23+ Intelligence
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  computeRoutingBundle,
  quickRoute,
  getRoutingSummary,
  emitRoutingEvent,
  getRoutingDebugSnapshot,
  ROUTING_VERSION
} from '../services/domain-routing-service';
import {
  RoutingInput,
  RoutingBundle,
  INTELLIGENCE_DOMAINS,
  DOMAIN_METADATA,
  DOMAIN_TOPIC_KEYWORDS,
  DEFAULT_ROUTING_CONFIG,
  IntelligenceDomain
} from '../types/domain-routing';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// VTID-01114: Request Validation Schemas
// =============================================================================

/**
 * Schema for full routing input
 */
const RoutingInputSchema = z.object({
  context: z.object({
    user_id: z.string().uuid().optional().default('00000000-0000-0000-0000-000000000000'),
    tenant_id: z.string().uuid().optional().default('00000000-0000-0000-0000-000000000001'),
    memory_items: z.array(z.object({
      category_key: z.string(),
      content: z.string(),
      importance: z.number().min(0).max(100).optional().default(50)
    })).optional().default([]),
    formatted_context: z.string().optional().default('')
  }).optional().default({}),
  intent: z.object({
    top_topics: z.array(z.object({
      topic_key: z.string(),
      score: z.number().min(0).max(100)
    })).optional().default([]),
    weaknesses: z.array(z.string()).optional().default([]),
    recommended_actions: z.array(z.object({
      type: z.string(),
      id: z.string(),
      why: z.array(z.object({ template: z.string() })).optional().default([])
    })).optional().default([])
  }).optional().default({}),
  current_message: z.string().min(1, 'current_message is required'),
  active_role: z.enum(['patient', 'professional', 'admin', 'developer']).optional().default('patient'),
  session: z.object({
    session_id: z.string().optional().default('api-session'),
    turn_number: z.number().min(1).optional().default(1),
    previous_domains: z.array(z.string()).optional()
  }).optional().default({})
});

/**
 * Schema for quick routing request
 */
const QuickRouteSchema = z.object({
  message: z.string().min(1, 'message is required'),
  user_id: z.string().uuid().optional(),
  role: z.enum(['patient', 'professional', 'admin', 'developer']).optional().default('patient')
});

// =============================================================================
// VTID-01114: In-Memory Debug Cache
// =============================================================================

/**
 * Simple in-memory cache for last routing decision (dev/debug only)
 * In production, this would be stored in Redis or similar
 */
interface DebugCacheEntry {
  input: RoutingInput;
  bundle: RoutingBundle;
  timestamp: string;
}

const debugCache = new Map<string, DebugCacheEntry>();
const MAX_DEBUG_CACHE_SIZE = 100;

function cacheDebugEntry(sessionId: string, input: RoutingInput, bundle: RoutingBundle): void {
  // Evict oldest entries if cache is full
  if (debugCache.size >= MAX_DEBUG_CACHE_SIZE) {
    const oldestKey = debugCache.keys().next().value;
    if (oldestKey) debugCache.delete(oldestKey);
  }

  debugCache.set(sessionId, {
    input,
    bundle,
    timestamp: new Date().toISOString()
  });
}

// =============================================================================
// VTID-01114: Routes
// =============================================================================

/**
 * POST /compute -> POST /api/v1/routing/compute
 *
 * Compute full routing bundle from context, intent, and message.
 * This is the main routing endpoint for the intelligence stack.
 */
router.post('/compute', async (req: Request, res: Response) => {
  console.log('[VTID-01114] POST /routing/compute');

  // Validate request body
  const validation = RoutingInputSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01114] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const input = validation.data as RoutingInput;

  try {
    // Compute routing bundle
    const bundle = computeRoutingBundle(input);

    // Cache for debug endpoint
    const sessionId = input.session?.session_id || 'default';
    cacheDebugEntry(sessionId, input, bundle);

    // Emit OASIS event for audit
    await emitRoutingEvent(
      bundle,
      input.context.user_id,
      input.context.tenant_id,
      sessionId
    );

    console.log(`[VTID-01114] ${getRoutingSummary(bundle)}`);

    return res.status(200).json({
      ok: true,
      routing_bundle: bundle,
      summary: getRoutingSummary(bundle)
    });
  } catch (err: any) {
    console.error('[VTID-01114] Routing computation error:', err.message);

    await emitOasisEvent({
      vtid: 'VTID-01114',
      type: 'orb.routing.error' as any,
      source: 'domain-routing',
      status: 'error',
      message: `Routing computation failed: ${err.message}`,
      payload: { error: err.message }
    }).catch(() => {});

    return res.status(500).json({
      ok: false,
      error: 'Routing computation failed',
      message: err.message
    });
  }
});

/**
 * POST /quick -> POST /api/v1/routing/quick
 *
 * Quick routing from just a message.
 * Uses minimal context for simple routing decisions.
 */
router.post('/quick', async (req: Request, res: Response) => {
  console.log('[VTID-01114] POST /routing/quick');

  // Validate request body
  const validation = QuickRouteSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01114] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { message, user_id, role } = validation.data;

  try {
    // Quick route
    const bundle = quickRoute(message, user_id, role);

    console.log(`[VTID-01114] Quick: ${getRoutingSummary(bundle)}`);

    return res.status(200).json({
      ok: true,
      routing_bundle: bundle,
      summary: getRoutingSummary(bundle)
    });
  } catch (err: any) {
    console.error('[VTID-01114] Quick routing error:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'Quick routing failed',
      message: err.message
    });
  }
});

/**
 * GET /debug -> GET /api/v1/routing/debug
 *
 * Get debug snapshot of last routing decision for a session.
 * For development and audit purposes.
 */
router.get('/debug', (req: Request, res: Response) => {
  console.log('[VTID-01114] GET /routing/debug');

  const sessionId = (req.query.session_id as string) || 'default';
  const cached = debugCache.get(sessionId);

  if (!cached) {
    return res.status(404).json({
      ok: false,
      error: 'No routing decision found for session',
      session_id: sessionId,
      available_sessions: Array.from(debugCache.keys())
    });
  }

  const snapshot = getRoutingDebugSnapshot(cached.input, cached.bundle);

  return res.status(200).json({
    ok: true,
    session_id: sessionId,
    cached_at: cached.timestamp,
    snapshot
  });
});

/**
 * GET /domains -> GET /api/v1/routing/domains
 *
 * List all supported intelligence domains with metadata.
 */
router.get('/domains', (_req: Request, res: Response) => {
  console.log('[VTID-01114] GET /routing/domains');

  const domains = INTELLIGENCE_DOMAINS.map(domain => ({
    domain,
    ...DOMAIN_METADATA[domain],
    topic_categories: Object.keys(DOMAIN_TOPIC_KEYWORDS[domain] || {})
  }));

  return res.status(200).json({
    ok: true,
    version: ROUTING_VERSION,
    domains,
    count: domains.length
  });
});

/**
 * GET /config -> GET /api/v1/routing/config
 *
 * Get current routing configuration.
 */
router.get('/config', (_req: Request, res: Response) => {
  console.log('[VTID-01114] GET /routing/config');

  return res.status(200).json({
    ok: true,
    version: ROUTING_VERSION,
    config: DEFAULT_ROUTING_CONFIG,
    constraints: {
      health_blocks_commerce: true,
      system_blocks_autonomy: true,
      mixed_requires_high_confidence: true
    }
  });
});

/**
 * GET /health -> GET /api/v1/routing/health
 *
 * Health check for routing system.
 */
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    status: 'ok',
    service: 'domain-routing',
    version: ROUTING_VERSION,
    vtid: 'VTID-01114',
    timestamp: new Date().toISOString(),
    capabilities: {
      full_routing: true,
      quick_routing: true,
      debug: true,
      audit: true
    },
    domains: {
      supported: INTELLIGENCE_DOMAINS.length,
      list: INTELLIGENCE_DOMAINS
    },
    stack_position: 'D22',
    dependencies: {
      upstream: ['D20 Context', 'D21 Intent'],
      downstream: ['D23+ Intelligence']
    }
  });
});

/**
 * POST /validate -> POST /api/v1/routing/validate
 *
 * Validate that a routing bundle allows specific operations.
 */
router.post('/validate', (req: Request, res: Response) => {
  console.log('[VTID-01114] POST /routing/validate');

  const { routing_bundle, operations } = req.body;

  if (!routing_bundle || !operations || !Array.isArray(operations)) {
    return res.status(400).json({
      ok: false,
      error: 'routing_bundle and operations[] are required'
    });
  }

  const results: Record<string, boolean> = {};

  for (const operation of operations) {
    switch (operation) {
      case 'commerce':
        results[operation] = routing_bundle.allows_commerce === true;
        break;
      case 'autonomous_action':
        results[operation] = (routing_bundle.autonomy_level || 0) >= 50;
        break;
      case 'sensitive_response':
        results[operation] = !(routing_bundle.safety_flags || []).some(
          (f: any) => f.severity === 'critical' || f.severity === 'high'
        );
        break;
      default:
        results[operation] = true;
    }
  }

  const allAllowed = Object.values(results).every(v => v);

  return res.status(200).json({
    ok: true,
    all_allowed: allAllowed,
    results
  });
});

/**
 * GET /topics/:domain -> GET /api/v1/routing/topics/:domain
 *
 * Get available topics for a specific domain.
 */
router.get('/topics/:domain', (req: Request, res: Response) => {
  const domain = req.params.domain as IntelligenceDomain;

  if (!INTELLIGENCE_DOMAINS.includes(domain)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid domain: ${domain}`,
      valid_domains: INTELLIGENCE_DOMAINS
    });
  }

  const topics = DOMAIN_TOPIC_KEYWORDS[domain] || {};

  return res.status(200).json({
    ok: true,
    domain,
    topics: Object.entries(topics).map(([key, keywords]) => ({
      topic_key: key,
      display_name: key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      keyword_count: keywords.length,
      sample_keywords: keywords.slice(0, 5)
    })),
    topic_count: Object.keys(topics).length
  });
});

export default router;
