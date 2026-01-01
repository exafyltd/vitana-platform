/**
 * VTID-01093: Unified Interest Topics Layer (Gateway)
 *
 * Topic Registry + User Topic Profile endpoints.
 * Single source of truth for all topic_keys across the platform.
 *
 * Endpoints:
 * - POST /api/v1/topics/recompute    - Recompute user's topic profile
 * - GET  /api/v1/topics/profile      - Get user's topic profile
 * - POST /api/v1/topics/registry     - Create a new topic in registry
 * - GET  /api/v1/topics/registry     - Get all topics from registry
 * - POST /api/v1/topics/validate     - Validate topic_keys against registry
 * - GET  /api/v1/topics/health       - Health check
 *
 * Internal helpers:
 * - validateTopicKeys()              - Validate topic keys (for other routes)
 *
 * Dependencies:
 * - VTID-01101 (context bridge)
 * - VTID-01093 (topics RPC)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// VTID-01093: Constants & Types
// =============================================================================

/**
 * Valid category types for topics
 */
const TOPIC_CATEGORIES = [
  'health',
  'community',
  'lifestyle',
  'nutrition',
  'sleep',
  'movement',
  'mindset',
  'medical',
  'longevity'
] as const;

type TopicCategory = typeof TOPIC_CATEGORIES[number];

/**
 * Safety levels for topics
 */
const SAFETY_LEVELS = ['safe', 'sensitive'] as const;
type SafetyLevel = typeof SAFETY_LEVELS[number];

/**
 * Topic registry entry schema
 */
const TopicRegistryEntrySchema = z.object({
  topic_key: z.string().min(1, 'topic_key is required').regex(/^[a-z][a-z0-9_]*$/, 'topic_key must be lowercase alphanumeric with underscores, starting with a letter'),
  display_name: z.string().min(1, 'display_name is required'),
  category: z.enum(TOPIC_CATEGORIES),
  description: z.string().optional(),
  synonyms: z.array(z.string()).optional().default([]),
  safety_level: z.enum(SAFETY_LEVELS).optional().default('safe')
});

type TopicRegistryEntry = z.infer<typeof TopicRegistryEntrySchema>;

/**
 * Recompute request schema
 */
const RecomputeRequestSchema = z.object({
  user_id: z.string().uuid().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional()
});

/**
 * Validate keys request schema
 */
const ValidateKeysRequestSchema = z.object({
  topic_keys: z.array(z.string()).min(1, 'At least one topic_key is required')
});

/**
 * Topic profile entry
 */
interface TopicProfileEntry {
  topic_key: string;
  affinity_score: number;
  source_weights: {
    diary: number;
    garden: number;
    behavior: number;
    social: number;
  };
  last_updated: string;
  display_name?: string;
  category?: string;
}

// =============================================================================
// VTID-01093: Helper Functions
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
 * Emit a topics-related OASIS event
 */
async function emitTopicsEvent(
  type: 'topics.registry.updated' | 'topics.profile.recomputed' | 'topics.profile.read',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01093',
    type: type as any, // Cast to bypass strict type check
    source: 'topics-gateway',
    status,
    message,
    payload
  }).catch(err => console.warn(`[VTID-01093] Failed to emit ${type}:`, err.message));
}

// =============================================================================
// VTID-01093: Exported Validation Helper (for other routes)
// =============================================================================

/**
 * Validate topic keys against the registry.
 * Used by other routes to enforce topic key validation.
 *
 * @param token - User's Bearer token
 * @param topicKeys - Array of topic keys to validate
 * @returns Validation result with valid and invalid keys
 */
export async function validateTopicKeys(
  token: string,
  topicKeys: string[]
): Promise<{ ok: boolean; valid_keys: string[]; invalid_keys: string[]; all_valid: boolean; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[VTID-01093] Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    return { ok: false, valid_keys: [], invalid_keys: topicKeys, all_valid: false, error: 'Gateway misconfigured' };
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('topics_validate_keys', {
      p_topic_keys: topicKeys
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01093] topics_validate_keys RPC not found');
        return { ok: false, valid_keys: [], invalid_keys: topicKeys, all_valid: false, error: 'Topics RPC not available' };
      }
      console.error('[VTID-01093] topics_validate_keys RPC error:', error.message);
      return { ok: false, valid_keys: [], invalid_keys: topicKeys, all_valid: false, error: error.message };
    }

    return {
      ok: data.ok,
      valid_keys: data.valid_keys || [],
      invalid_keys: data.invalid_keys || [],
      all_valid: data.all_valid
    };
  } catch (err: any) {
    console.error('[VTID-01093] validateTopicKeys error:', err.message);
    return { ok: false, valid_keys: [], invalid_keys: topicKeys, all_valid: false, error: err.message };
  }
}

// =============================================================================
// VTID-01093: Routes
// =============================================================================

/**
 * POST /recompute -> POST /api/v1/topics/recompute
 *
 * Recompute user's topic profile from all signal sources.
 */
router.post('/recompute', async (req: Request, res: Response) => {
  console.log('[VTID-01093] POST /topics/recompute');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = RecomputeRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01093] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { user_id, date } = validation.data;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'Gateway misconfigured'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    // Call topics_recompute_user_profile RPC
    const { data, error } = await supabase.rpc('topics_recompute_user_profile', {
      p_user_id: user_id || null,
      p_date: date || null
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01093] topics_recompute_user_profile RPC not found');
        return res.status(503).json({
          ok: false,
          error: 'Topics RPC not available (VTID-01093 dependency)'
        });
      }
      console.error('[VTID-01093] topics_recompute_user_profile RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    // Emit OASIS event
    await emitTopicsEvent(
      'topics.profile.recomputed',
      'success',
      `Topic profile recomputed: ${data.topics_updated} topics updated`,
      {
        user_id: data.user_id,
        topics_updated: data.topics_updated,
        top_topics: data.top_topics,
        computed_at: data.computed_at
      }
    );

    console.log(`[VTID-01093] Topic profile recomputed: ${data.topics_updated} topics`);

    return res.status(200).json({
      ok: true,
      user_id: data.user_id,
      topics_updated: data.topics_updated,
      top_topics: data.top_topics,
      computed_at: data.computed_at
    });
  } catch (err: any) {
    console.error('[VTID-01093] topics_recompute_user_profile error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /profile -> GET /api/v1/topics/profile
 *
 * Get user's topic profile.
 */
router.get('/profile', async (req: Request, res: Response) => {
  console.log('[VTID-01093] GET /topics/profile');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const userId = req.query.user_id as string | undefined;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'Gateway misconfigured'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    // Call topics_get_user_profile RPC
    const { data, error } = await supabase.rpc('topics_get_user_profile', {
      p_user_id: userId || null
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01093] topics_get_user_profile RPC not found');
        return res.status(503).json({
          ok: false,
          error: 'Topics RPC not available (VTID-01093 dependency)'
        });
      }
      console.error('[VTID-01093] topics_get_user_profile RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    // Emit OASIS event
    await emitTopicsEvent(
      'topics.profile.read',
      'info',
      `Topic profile read: ${data.topics_count} topics`,
      {
        user_id: data.user_id,
        topics_count: data.topics_count
      }
    );

    console.log(`[VTID-01093] Topic profile fetched: ${data.topics_count} topics`);

    return res.status(200).json({
      ok: true,
      user_id: data.user_id,
      topics: data.topics,
      top_topics: data.top_topics,
      topics_count: data.topics_count
    });
  } catch (err: any) {
    console.error('[VTID-01093] topics_get_user_profile error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /registry -> POST /api/v1/topics/registry
 *
 * Create a new topic in the registry.
 */
router.post('/registry', async (req: Request, res: Response) => {
  console.log('[VTID-01093] POST /topics/registry');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = TopicRegistryEntrySchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01093] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const entry = validation.data;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'Gateway misconfigured'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    // Call topics_create_registry_entry RPC
    const { data, error } = await supabase.rpc('topics_create_registry_entry', {
      p_payload: entry
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01093] topics_create_registry_entry RPC not found');
        return res.status(503).json({
          ok: false,
          error: 'Topics RPC not available (VTID-01093 dependency)'
        });
      }
      console.error('[VTID-01093] topics_create_registry_entry RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data.ok) {
      return res.status(400).json({
        ok: false,
        error: data.error,
        message: data.message
      });
    }

    // Emit OASIS event
    await emitTopicsEvent(
      'topics.registry.updated',
      'success',
      `Topic created: ${entry.topic_key}`,
      {
        topic_id: data.id,
        topic_key: entry.topic_key,
        category: entry.category,
        action: 'created'
      }
    );

    console.log(`[VTID-01093] Topic created: ${entry.topic_key}`);

    return res.status(201).json({
      ok: true,
      id: data.id,
      topic_key: data.topic_key,
      category: data.category
    });
  } catch (err: any) {
    console.error('[VTID-01093] topics_create_registry_entry error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /registry -> GET /api/v1/topics/registry
 *
 * Get all topics from registry.
 */
router.get('/registry', async (req: Request, res: Response) => {
  console.log('[VTID-01093] GET /topics/registry');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const category = req.query.category as string | undefined;

  // Validate category if provided
  if (category && !TOPIC_CATEGORIES.includes(category as TopicCategory)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid category. Valid categories: ${TOPIC_CATEGORIES.join(', ')}`
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'Gateway misconfigured'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    // Call topics_get_registry RPC
    const { data, error } = await supabase.rpc('topics_get_registry', {
      p_category: category || null
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01093] topics_get_registry RPC not found');
        return res.status(503).json({
          ok: false,
          error: 'Topics RPC not available (VTID-01093 dependency)'
        });
      }
      console.error('[VTID-01093] topics_get_registry RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    console.log(`[VTID-01093] Registry fetched: ${data.count} topics`);

    return res.status(200).json({
      ok: true,
      topics: data.topics,
      count: data.count,
      category_filter: data.category_filter
    });
  } catch (err: any) {
    console.error('[VTID-01093] topics_get_registry error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /validate -> POST /api/v1/topics/validate
 *
 * Validate topic_keys against registry.
 */
router.post('/validate', async (req: Request, res: Response) => {
  console.log('[VTID-01093] POST /topics/validate');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = ValidateKeysRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01093] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { topic_keys } = validation.data;

  const result = await validateTopicKeys(token, topic_keys);

  if (!result.ok && result.error) {
    if (result.error.includes('not available')) {
      return res.status(503).json(result);
    }
    return res.status(502).json(result);
  }

  return res.status(200).json(result);
});

/**
 * GET /health -> GET /api/v1/topics/health
 *
 * Health check for topics system.
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'topics-gateway',
    version: '1.0.0',
    vtid: 'VTID-01093',
    timestamp: new Date().toISOString(),
    capabilities: {
      recompute: hasSupabaseUrl && hasSupabaseKey,
      profile: hasSupabaseUrl && hasSupabaseKey,
      registry: hasSupabaseUrl && hasSupabaseKey,
      validate: hasSupabaseUrl && hasSupabaseKey,
      categories: TOPIC_CATEGORIES
    },
    scoring: {
      diary_mention: 6,
      garden_node: 10,
      accepted_match: 12,
      attended_event: 8,
      used_service: 10,
      dismissed_match: -6,
      decay_per_day: 1,
      decay_threshold_days: 30,
      floor_score: 10
    },
    dependencies: {
      'VTID-01101': 'context_bridge',
      'VTID-01093': 'topics_rpc'
    }
  });
});

export default router;
