/**
 * VTID-01092: Services + Products as Relationship Memory (Gateway)
 *
 * Catalog and offers endpoints for managing services/products and user relationships.
 *
 * Endpoints:
 * - POST /api/v1/catalog/services    - Add a service to catalog
 * - POST /api/v1/catalog/products    - Add a product to catalog
 * - POST /api/v1/offers/state        - Set user state for service/product
 * - POST /api/v1/offers/outcome      - Record usage outcome
 * - GET  /api/v1/offers/recommendations - Get recommendations
 * - GET  /api/v1/offers/memory       - Get user offers memory
 * - GET  /api/v1/offers/health       - Health check
 *
 * Dependencies:
 * - VTID-01101 (context bridge)
 * - VTID-01104 (memory core)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// VTID-01092: Constants & Types
// =============================================================================

/**
 * Valid service types
 */
const SERVICE_TYPES = ['coach', 'doctor', 'lab', 'wellness', 'nutrition', 'fitness', 'therapy', 'other'] as const;
type ServiceType = typeof SERVICE_TYPES[number];

/**
 * Valid product types
 */
const PRODUCT_TYPES = ['supplement', 'device', 'food', 'wearable', 'app', 'other'] as const;
type ProductType = typeof PRODUCT_TYPES[number];

/**
 * Valid offer states
 */
const OFFER_STATES = ['viewed', 'saved', 'used', 'dismissed', 'rated'] as const;
type OfferState = typeof OFFER_STATES[number];

/**
 * Valid outcome types
 */
const OUTCOME_TYPES = ['sleep', 'stress', 'movement', 'nutrition', 'social', 'energy', 'other'] as const;
type OutcomeType = typeof OUTCOME_TYPES[number];

/**
 * Valid perceived impacts
 */
const PERCEIVED_IMPACTS = ['better', 'same', 'worse'] as const;
type PerceivedImpact = typeof PERCEIVED_IMPACTS[number];

/**
 * Target types (service or product)
 */
const TARGET_TYPES = ['service', 'product'] as const;
type TargetType = typeof TARGET_TYPES[number];

// =============================================================================
// VTID-01092: Request Schemas
// =============================================================================

const AddServiceRequestSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  service_type: z.enum(SERVICE_TYPES),
  topic_keys: z.array(z.string()).optional().default([]),
  provider_name: z.string().optional(),
  metadata: z.record(z.unknown()).optional().default({})
});

const AddProductRequestSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  product_type: z.enum(PRODUCT_TYPES),
  topic_keys: z.array(z.string()).optional().default([]),
  metadata: z.record(z.unknown()).optional().default({})
});

const SetStateRequestSchema = z.object({
  target_type: z.enum(TARGET_TYPES),
  target_id: z.string().uuid(),
  state: z.enum(OFFER_STATES),
  trust_score: z.number().int().min(0).max(100).optional(),
  notes: z.string().optional()
});

const RecordOutcomeRequestSchema = z.object({
  target_type: z.enum(TARGET_TYPES),
  target_id: z.string().uuid(),
  outcome_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format'),
  outcome_type: z.enum(OUTCOME_TYPES),
  perceived_impact: z.enum(PERCEIVED_IMPACTS),
  evidence: z.record(z.unknown()).optional().default({})
});

const RecommendationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  target_type: z.enum(TARGET_TYPES).optional()
});

const MemoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  target_type: z.enum(TARGET_TYPES).optional(),
  state: z.enum(OFFER_STATES).optional()
});

// =============================================================================
// VTID-01092: Helper Functions
// =============================================================================

/**
 * Extract Bearer token from Authorization header.
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Emit an offers-related OASIS event
 */
async function emitOffersEvent(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01092',
    type: type as any,
    source: 'offers-gateway',
    status,
    message,
    payload
  }).catch(err => console.warn(`[VTID-01092] Failed to emit ${type}:`, err.message));
}

// =============================================================================
// VTID-01092: Catalog Routes
// =============================================================================

/**
 * POST /services -> POST /api/v1/catalog/services
 *
 * Add a service to the catalog.
 */
router.post('/catalog/services', async (req: Request, res: Response) => {
  console.log('[VTID-01092] POST /catalog/services');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = AddServiceRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01092] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { name, service_type, topic_keys, provider_name, metadata } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('catalog_add_service', {
      p_payload: {
        name,
        service_type,
        topic_keys,
        provider_name,
        metadata
      }
    });

    if (error) {
      console.error('[VTID-01092] catalog_add_service RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit OASIS event
    await emitOffersEvent(
      'catalog.service.created',
      'success',
      `Service added to catalog: ${name}`,
      {
        service_id: data.id,
        name,
        service_type,
        topic_keys
      }
    );

    console.log(`[VTID-01092] Service added: ${data.id} (${name})`);

    return res.status(200).json({
      ok: true,
      id: data.id,
      name: data.name,
      service_type: data.service_type
    });
  } catch (err: any) {
    console.error('[VTID-01092] catalog_add_service error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /products -> POST /api/v1/catalog/products
 *
 * Add a product to the catalog.
 */
router.post('/catalog/products', async (req: Request, res: Response) => {
  console.log('[VTID-01092] POST /catalog/products');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = AddProductRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01092] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { name, product_type, topic_keys, metadata } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('catalog_add_product', {
      p_payload: {
        name,
        product_type,
        topic_keys,
        metadata
      }
    });

    if (error) {
      console.error('[VTID-01092] catalog_add_product RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit OASIS event
    await emitOffersEvent(
      'catalog.product.created',
      'success',
      `Product added to catalog: ${name}`,
      {
        product_id: data.id,
        name,
        product_type,
        topic_keys
      }
    );

    console.log(`[VTID-01092] Product added: ${data.id} (${name})`);

    return res.status(200).json({
      ok: true,
      id: data.id,
      name: data.name,
      product_type: data.product_type
    });
  } catch (err: any) {
    console.error('[VTID-01092] catalog_add_product error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

// =============================================================================
// VTID-01092: Offers Routes
// =============================================================================

/**
 * POST /state -> POST /api/v1/offers/state
 *
 * Set user state for a service/product (viewed, saved, used, dismissed, rated).
 */
router.post('/offers/state', async (req: Request, res: Response) => {
  console.log('[VTID-01092] POST /offers/state');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = SetStateRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01092] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { target_type, target_id, state, trust_score, notes } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('offers_set_state', {
      p_payload: {
        target_type,
        target_id,
        state,
        trust_score,
        notes
      }
    });

    if (error) {
      console.error('[VTID-01092] offers_set_state RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit OASIS events
    await emitOffersEvent(
      'offers.state.updated',
      'success',
      `Offer state updated: ${state}`,
      {
        offer_id: data.id,
        target_type,
        target_id,
        state,
        trust_score,
        strength_delta: data.strength_delta
      }
    );

    // Also emit relationship edge strengthened event
    await emitOffersEvent(
      'relationship.edge.strengthened',
      'success',
      `Relationship edge updated: ${target_type} (${state})`,
      {
        target_type,
        target_id,
        state,
        strength_delta: data.strength_delta
      }
    );

    console.log(`[VTID-01092] Offer state set: ${data.id} -> ${state}`);

    return res.status(200).json({
      ok: true,
      id: data.id,
      target_type: data.target_type,
      target_id: data.target_id,
      state: data.state,
      strength_delta: data.strength_delta
    });
  } catch (err: any) {
    console.error('[VTID-01092] offers_set_state error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /outcome -> POST /api/v1/offers/outcome
 *
 * Record a perceived outcome from using a service/product.
 */
router.post('/offers/outcome', async (req: Request, res: Response) => {
  console.log('[VTID-01092] POST /offers/outcome');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = RecordOutcomeRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01092] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { target_type, target_id, outcome_date, outcome_type, perceived_impact, evidence } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('offers_record_outcome', {
      p_payload: {
        target_type,
        target_id,
        outcome_date,
        outcome_type,
        perceived_impact,
        evidence
      }
    });

    if (error) {
      console.error('[VTID-01092] offers_record_outcome RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit OASIS event
    await emitOffersEvent(
      'offers.outcome.recorded',
      'success',
      `Outcome recorded: ${outcome_type} (${perceived_impact})`,
      {
        outcome_id: data.id,
        target_type,
        target_id,
        outcome_date,
        outcome_type,
        perceived_impact
      }
    );

    console.log(`[VTID-01092] Outcome recorded: ${data.id} (${outcome_type} -> ${perceived_impact})`);

    return res.status(200).json({
      ok: true,
      id: data.id,
      target_type: data.target_type,
      target_id: data.target_id,
      outcome_type: data.outcome_type,
      perceived_impact: data.perceived_impact
    });
  } catch (err: any) {
    console.error('[VTID-01092] offers_record_outcome error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /recommendations -> GET /api/v1/offers/recommendations
 *
 * Get recommended services/products based on relationship strength.
 */
router.get('/offers/recommendations', async (req: Request, res: Response) => {
  console.log('[VTID-01092] GET /offers/recommendations');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query parameters
  const queryValidation = RecommendationsQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid query parameters',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { limit, target_type } = queryValidation.data;

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('offers_get_recommendations', {
      p_limit: limit,
      p_target_type: target_type || null
    });

    if (error) {
      console.error('[VTID-01092] offers_get_recommendations RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit OASIS event
    await emitOffersEvent(
      'offers.recommendations.read',
      'info',
      `Recommendations fetched: ${(data.services?.length || 0) + (data.products?.length || 0)} items`,
      {
        limit,
        target_type,
        services_count: data.services?.length || 0,
        products_count: data.products?.length || 0
      }
    );

    console.log(`[VTID-01092] Recommendations fetched: ${(data.services?.length || 0)} services, ${(data.products?.length || 0)} products`);

    return res.status(200).json({
      ok: true,
      services: data.services || [],
      products: data.products || [],
      query: data.query
    });
  } catch (err: any) {
    console.error('[VTID-01092] offers_get_recommendations error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /memory -> GET /api/v1/offers/memory
 *
 * Get user's offers memory (tracked services/products).
 */
router.get('/offers/memory', async (req: Request, res: Response) => {
  console.log('[VTID-01092] GET /offers/memory');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query parameters
  const queryValidation = MemoryQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid query parameters',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { limit, target_type, state } = queryValidation.data;

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('offers_get_memory', {
      p_limit: limit,
      p_target_type: target_type || null,
      p_state: state || null
    });

    if (error) {
      console.error('[VTID-01092] offers_get_memory RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    console.log(`[VTID-01092] Offers memory fetched: ${data.items?.length || 0} items`);

    return res.status(200).json({
      ok: true,
      items: data.items || [],
      query: data.query
    });
  } catch (err: any) {
    console.error('[VTID-01092] offers_get_memory error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /health -> GET /api/v1/offers/health
 *
 * Health check for offers system.
 */
router.get('/offers/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'offers-gateway',
    version: '1.0.0',
    vtid: 'VTID-01092',
    timestamp: new Date().toISOString(),
    capabilities: {
      catalog_services: hasSupabaseUrl && hasSupabaseKey,
      catalog_products: hasSupabaseUrl && hasSupabaseKey,
      offers_state: hasSupabaseUrl && hasSupabaseKey,
      offers_outcome: hasSupabaseUrl && hasSupabaseKey,
      offers_recommendations: hasSupabaseUrl && hasSupabaseKey,
      offers_memory: hasSupabaseUrl && hasSupabaseKey
    },
    endpoints: {
      'POST /catalog/services': 'Add service to catalog',
      'POST /catalog/products': 'Add product to catalog',
      'POST /offers/state': 'Set user state for service/product',
      'POST /offers/outcome': 'Record usage outcome',
      'GET /offers/recommendations': 'Get recommendations',
      'GET /offers/memory': 'Get user offers memory'
    },
    dependencies: {
      'VTID-01101': 'context_bridge',
      'VTID-01104': 'memory_core'
    }
  });
});

export default router;
