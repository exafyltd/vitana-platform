/**
 * VTID-01105: ORB Memory Wiring v1 (Gateway)
 * VTID-01085: Memory Retrieve Router v1 (Unified Memory Access)
 *
 * Memory write/read endpoints and auto-write hooks for ORB conversations.
 *
 * Endpoints:
 * - POST /api/v1/memory/write    - Write a memory item
 * - GET  /api/v1/memory/context  - Fetch memory context
 * - POST /api/v1/memory/retrieve - Unified memory retrieval gateway (VTID-01085)
 * - GET  /api/v1/memory/health   - Health check
 *
 * Internal helpers:
 * - writeMemoryItem()            - Direct memory write (for ORB auto-write)
 * - classifyCategory()           - Deterministic category classification
 *
 * Dependencies:
 * - VTID-01102 (context bridge)
 * - VTID-01104 (memory RPC)
 * - VTID-01085 (memory retrieve RPC)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// VTID-01105: Constants & Types
// =============================================================================

/**
 * Valid category keys for memory items
 */
const CATEGORY_KEYS = [
  'conversation',
  'health',
  'relationships',
  'community',
  'preferences',
  'goals',
  'tasks',
  'products_services',
  'events_meetups',
  'notes'
] as const;

type CategoryKey = typeof CATEGORY_KEYS[number];

/**
 * Valid source types for memory items
 */
const SOURCE_TYPES = ['orb_text', 'orb_voice', 'system'] as const;
type SourceType = typeof SOURCE_TYPES[number];

/**
 * Memory write request schema
 */
const MemoryWriteRequestSchema = z.object({
  category_key: z.enum(CATEGORY_KEYS).optional(),
  source: z.enum(SOURCE_TYPES),
  content: z.string().min(1, 'Content is required'),
  importance: z.number().int().min(1).max(100).default(10),
  occurred_at: z.string().datetime().optional(),
  content_json: z.record(z.unknown()).optional().default({})
});

type MemoryWriteRequest = z.infer<typeof MemoryWriteRequestSchema>;

/**
 * Memory context query parameters
 */
const MemoryContextQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  categories: z.string().optional(), // comma-separated
  since: z.string().datetime().optional()
});

/**
 * Memory item structure (returned from RPC)
 */
interface MemoryItem {
  id: string;
  category_key: CategoryKey;
  source: SourceType;
  content: string;
  content_json: Record<string, unknown>;
  importance: number;
  occurred_at: string;
  created_at: string;
}

// =============================================================================
// VTID-01085: Memory Retrieve Router Constants & Types
// =============================================================================

/**
 * Valid intent types for memory retrieve
 */
const RETRIEVE_INTENTS = [
  'health',
  'longevity',
  'community',
  'lifestyle',
  'planner',
  'general'
] as const;

type RetrieveIntent = typeof RETRIEVE_INTENTS[number];

/**
 * Valid mode types for memory retrieve
 */
const RETRIEVE_MODES = ['summary', 'detail'] as const;
type RetrieveMode = typeof RETRIEVE_MODES[number];

/**
 * Memory retrieve request schema (VTID-01085)
 */
const MemoryRetrieveRequestSchema = z.object({
  intent: z.enum(RETRIEVE_INTENTS).default('general'),
  mode: z.enum(RETRIEVE_MODES).default('summary'),
  query: z.string().nullable().optional(),
  time_range: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format').optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format').optional()
  }).optional(),
  include: z.object({
    diary: z.boolean().default(true),
    garden: z.boolean().default(true),
    longevity: z.boolean().default(true),
    community: z.boolean().default(true)
  }).optional()
});

type MemoryRetrieveRequest = z.infer<typeof MemoryRetrieveRequestSchema>;

/**
 * Memory retrieve response structure (VTID-01085)
 */
interface MemoryRetrieveResponse {
  ok: boolean;
  intent: RetrieveIntent;
  mode: RetrieveMode;
  time_range: { from: string; to: string };
  data: {
    garden_summary: Record<string, unknown>;
    longevity_summary: Record<string, unknown>;
    community_recommendations: unknown[];
    diary_highlights: unknown[];
  };
  meta: {
    tenant_id: string;
    user_id: string;
    active_role: string;
    redacted: boolean;
    redactions: Array<{ field: string; reason: string }>;
    sources: {
      diary_entries: number;
      garden_nodes: number;
      longevity_days: number;
      community_recs: number;
    };
    audit_id: string;
  };
}

// =============================================================================
// VTID-01105: Deterministic Category Classification
// =============================================================================

/**
 * Deterministic category classification (rules-based v1)
 * Maps message content → category_key based on keyword matching.
 * Order matters - first match wins.
 *
 * @param content - The text content to classify
 * @returns The classified category key
 */
export function classifyCategory(content: string): CategoryKey {
  const lowerContent = content.toLowerCase();

  // Health-related keywords (highest priority for personal health data)
  const healthKeywords = [
    'lab', 'biomarker', 'blood', 'genomics', 'sleep', 'steps', 'hrv',
    'heart rate', 'diet', 'nutrition', 'hydration', 'workout', 'exercise',
    'weight', 'bmi', 'glucose', 'insulin', 'cholesterol', 'vitamin',
    'supplement', 'medication', 'medicine', 'doctor', 'appointment',
    'symptom', 'pain', 'headache', 'fever', 'tired', 'fatigue', 'energy'
  ];
  for (const keyword of healthKeywords) {
    if (lowerContent.includes(keyword)) {
      return 'health';
    }
  }

  // Relationships keywords
  const relationshipsKeywords = [
    'wife', 'husband', 'partner', 'friend', 'relationship', 'dating',
    'match', 'family', 'mother', 'father', 'sister', 'brother', 'child',
    'son', 'daughter', 'parent', 'spouse', 'boyfriend', 'girlfriend'
  ];
  for (const keyword of relationshipsKeywords) {
    if (lowerContent.includes(keyword)) {
      return 'relationships';
    }
  }

  // Community & Events keywords (check events_meetups first for explicit matches)
  const eventsMeetupsKeywords = [
    'meetup', 'event', 'conference', 'workshop', 'webinar', 'seminar',
    'gathering', 'party', 'celebration', 'anniversary', 'birthday'
  ];
  for (const keyword of eventsMeetupsKeywords) {
    if (lowerContent.includes(keyword)) {
      return 'events_meetups';
    }
  }

  const communityKeywords = [
    'group', 'community', 'live room', 'room', 'networking', 'club',
    'member', 'membership', 'forum', 'discussion', 'team', 'colleague'
  ];
  for (const keyword of communityKeywords) {
    if (lowerContent.includes(keyword)) {
      return 'community';
    }
  }

  // Products & Services keywords
  const productsServicesKeywords = [
    'buy', 'product', 'service', 'recommend', 'affiliate', 'link',
    'purchase', 'order', 'subscription', 'plan', 'pricing', 'cost',
    'discount', 'coupon', 'deal', 'offer', 'review', 'rating'
  ];
  for (const keyword of productsServicesKeywords) {
    if (lowerContent.includes(keyword)) {
      return 'products_services';
    }
  }

  // Tasks keywords (dev/work-related)
  const tasksKeywords = [
    'task', 'vtid', 'spec', 'deploy', 'gateway', 'oasis', 'bug', 'fix',
    'implement', 'feature', 'ticket', 'issue', 'pr', 'pull request',
    'merge', 'commit', 'code', 'test', 'debug', 'review'
  ];
  for (const keyword of tasksKeywords) {
    if (lowerContent.includes(keyword)) {
      return 'tasks';
    }
  }

  // Goals keywords
  const goalsKeywords = [
    'goal', 'plan', 'habit', 'routine', 'objective', 'target', 'milestone',
    'resolution', 'intention', 'aspiration', 'ambition', 'dream', 'vision',
    'want to', 'going to', 'will start', 'need to'
  ];
  for (const keyword of goalsKeywords) {
    if (lowerContent.includes(keyword)) {
      return 'goals';
    }
  }

  // Preferences keywords
  const preferencesKeywords = [
    'prefer', 'like', 'love', 'hate', 'dislike', 'favorite', 'favourite',
    'always', 'never', 'usually', 'typically', 'often', 'setting', 'option'
  ];
  for (const keyword of preferencesKeywords) {
    if (lowerContent.includes(keyword)) {
      return 'preferences';
    }
  }

  // Default to conversation for general chat
  return 'conversation';
}

// =============================================================================
// VTID-01105: Helper Functions
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
 * Emit a memory-related OASIS event
 */
async function emitMemoryEvent(
  type: 'memory.write' | 'memory.read' | 'memory.write.user_message' | 'memory.write.assistant_message' |
        'memory.retrieve.requested' | 'memory.retrieve.denied' | 'memory.retrieve.completed',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>,
  vtid: string = 'VTID-01105'
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: type as any, // Cast to bypass strict type check (we're extending event types)
    source: 'memory-gateway',
    status,
    message,
    payload
  }).catch(err => console.warn(`[${vtid}] Failed to emit ${type}:`, err.message));
}

// =============================================================================
// VTID-01105: Internal Memory Write Helper (for ORB auto-write)
// =============================================================================

/**
 * Internal helper to write a memory item directly.
 * Used by ORB chat handlers for auto-write functionality.
 *
 * @param token - User's Bearer token
 * @param params - Memory item parameters
 * @returns Result with ok status and memory item id
 */
export async function writeMemoryItem(
  token: string,
  params: {
    source: SourceType;
    content: string;
    content_json?: Record<string, unknown>;
    importance?: number;
    category_key?: CategoryKey;
    occurred_at?: string;
  }
): Promise<{ ok: boolean; id?: string; category_key?: CategoryKey; occurred_at?: string; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[VTID-01105] Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    return { ok: false, error: 'Gateway misconfigured' };
  }

  try {
    // Auto-classify if category not provided
    const categoryKey = params.category_key || classifyCategory(params.content);
    const occurredAt = params.occurred_at || new Date().toISOString();
    const importance = params.importance || 10;
    const contentJson = params.content_json || {};

    // Create user-context Supabase client
    const supabase = createUserSupabaseClient(token);

    // Call memory_write_item RPC
    const { data, error } = await supabase.rpc('memory_write_item', {
      p_category_key: categoryKey,
      p_source: params.source,
      p_content: params.content,
      p_content_json: contentJson,
      p_importance: importance,
      p_occurred_at: occurredAt
    });

    if (error) {
      // Check if RPC doesn't exist (dependency not ready)
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01105] memory_write_item RPC not found (VTID-01104 not deployed yet)');
        return { ok: false, error: 'Memory RPC not available (VTID-01104 dependency)' };
      }
      console.error('[VTID-01105] memory_write_item RPC error:', error.message);
      return { ok: false, error: error.message };
    }

    const memoryId = data?.id || randomUUID();

    console.log(`[VTID-01105] Memory item written: ${memoryId} (${categoryKey})`);

    return {
      ok: true,
      id: memoryId,
      category_key: categoryKey,
      occurred_at: occurredAt
    };
  } catch (err: any) {
    console.error('[VTID-01105] writeMemoryItem error:', err.message);
    return { ok: false, error: err.message };
  }
}

// =============================================================================
// VTID-01105: Routes
// =============================================================================

/**
 * POST /write -> POST /api/v1/memory/write
 *
 * Write a memory item.
 */
router.post('/write', async (req: Request, res: Response) => {
  console.log('[VTID-01105] POST /memory/write');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = MemoryWriteRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01105] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { source, content, importance, category_key, occurred_at, content_json } = validation.data;

  // Write memory item
  const result = await writeMemoryItem(token, {
    source,
    content,
    content_json,
    importance,
    category_key,
    occurred_at
  });

  if (!result.ok) {
    // Determine error code
    if (result.error?.includes('dependency') || result.error?.includes('RPC not available')) {
      return res.status(503).json({
        ok: false,
        error: result.error
      });
    }
    return res.status(502).json({
      ok: false,
      error: result.error || 'Memory write failed'
    });
  }

  // Emit OASIS event
  await emitMemoryEvent(
    'memory.write',
    'success',
    `Memory item written: ${result.category_key}`,
    {
      memory_id: result.id,
      category_key: result.category_key,
      source,
      content_length: content.length,
      importance
    }
  );

  return res.status(200).json({
    ok: true,
    id: result.id,
    category_key: result.category_key,
    occurred_at: result.occurred_at
  });
});

/**
 * GET /context -> GET /api/v1/memory/context
 *
 * Fetch memory context for the current user.
 */
router.get('/context', async (req: Request, res: Response) => {
  console.log('[VTID-01105] GET /memory/context');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query parameters
  const queryValidation = MemoryContextQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid query parameters',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { limit, categories, since } = queryValidation.data;

  // Parse categories if provided
  let categoriesArray: string[] | null = null;
  if (categories) {
    categoriesArray = categories.split(',').map(c => c.trim()).filter(c => c.length > 0);
    // Validate each category
    for (const cat of categoriesArray) {
      if (!CATEGORY_KEYS.includes(cat as CategoryKey)) {
        return res.status(400).json({
          ok: false,
          error: `Invalid category: ${cat}. Valid categories: ${CATEGORY_KEYS.join(', ')}`
        });
      }
    }
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

    // Call memory_get_context RPC
    const { data, error } = await supabase.rpc('memory_get_context', {
      p_limit: limit,
      p_categories: categoriesArray,
      p_since: since || null
    });

    if (error) {
      // Check if RPC doesn't exist
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01105] memory_get_context RPC not found (VTID-01104 not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Memory RPC not available (VTID-01104 dependency)'
        });
      }
      console.error('[VTID-01105] memory_get_context RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    // Emit OASIS event
    await emitMemoryEvent(
      'memory.read',
      'success',
      `Memory context fetched: ${(data as MemoryItem[])?.length || 0} items`,
      {
        limit,
        categories: categoriesArray,
        since,
        items_returned: (data as MemoryItem[])?.length || 0
      }
    );

    console.log(`[VTID-01105] Memory context fetched: ${(data as MemoryItem[])?.length || 0} items`);

    return res.status(200).json({
      ok: true,
      items: data || [],
      query: {
        limit,
        categories: categoriesArray,
        since
      }
    });
  } catch (err: any) {
    console.error('[VTID-01105] memory_get_context error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

// =============================================================================
// VTID-01085: Memory Retrieve Router
// =============================================================================

/**
 * POST /retrieve -> POST /api/v1/memory/retrieve
 *
 * Unified memory retrieval gateway for the assistant (ORB / AI Assistant / Autopilot).
 * Returns diary entries, Memory Garden summary, longevity signals, and community recommendations.
 *
 * Role-aware access control:
 * - Patient: can retrieve own full memory
 * - Professional/Staff/Admin: default deny for diary + garden unless explicit grant exists
 *
 * OASIS Events:
 * - memory.retrieve.requested: When retrieval is initiated
 * - memory.retrieve.denied: If access is denied
 * - memory.retrieve.completed: When retrieval succeeds
 */
router.post('/retrieve', async (req: Request, res: Response) => {
  console.log('[VTID-01085] POST /memory/retrieve');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = MemoryRetrieveRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01085] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { intent, mode, query, time_range, include } = validation.data;

  // Build payload for RPC
  const rpcPayload = {
    intent,
    mode,
    query: query || null,
    time_range: time_range || {},
    include: include || { diary: true, garden: true, longevity: true, community: true }
  };

  // Emit 'requested' event
  await emitMemoryEvent(
    'memory.retrieve.requested',
    'info',
    `Memory retrieve requested: intent=${intent}, mode=${mode}`,
    {
      intent,
      mode,
      query: query || null,
      time_range: time_range || null,
      include: rpcPayload.include
    },
    'VTID-01085'
  );

  try {
    const supabase = createUserSupabaseClient(token);

    // Call memory_retrieve RPC
    const { data, error } = await supabase.rpc('memory_retrieve', {
      p_payload: rpcPayload
    });

    if (error) {
      // Check if RPC doesn't exist
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01085] memory_retrieve RPC not found (migration not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Memory retrieve RPC not available (VTID-01085 migration required)'
        });
      }
      console.error('[VTID-01085] memory_retrieve RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    // Check if access was denied
    if (data?.meta?.redacted && data.meta.redactions.length > 0) {
      // Partial denial - some data was redacted
      await emitMemoryEvent(
        'memory.retrieve.denied',
        'warning',
        `Memory retrieve partially denied: ${data.meta.redactions.length} redactions`,
        {
          intent,
          mode,
          redactions: data.meta.redactions,
          audit_id: data.meta.audit_id
        },
        'VTID-01085'
      );
    }

    // Check if completely denied (decision was 'deny')
    const totalSources =
      (data?.meta?.sources?.diary_entries || 0) +
      (data?.meta?.sources?.garden_nodes || 0) +
      (data?.meta?.sources?.longevity_days || 0) +
      (data?.meta?.sources?.community_recs || 0);

    if (totalSources === 0 && data?.meta?.redacted) {
      await emitMemoryEvent(
        'memory.retrieve.denied',
        'error',
        `Memory retrieve denied: no access grants`,
        {
          intent,
          mode,
          active_role: data.meta.active_role,
          redactions: data.meta.redactions,
          audit_id: data.meta.audit_id
        },
        'VTID-01085'
      );

      return res.status(403).json({
        ok: false,
        error: 'ACCESS_DENIED',
        message: 'No memory access grants for the requested data',
        redactions: data.meta.redactions,
        audit_id: data.meta.audit_id
      });
    }

    // Success - emit completed event
    await emitMemoryEvent(
      'memory.retrieve.completed',
      'success',
      `Memory retrieve completed: ${totalSources} total items`,
      {
        intent,
        mode,
        sources: data.meta.sources,
        redacted: data.meta.redacted,
        redactions_count: data.meta.redactions?.length || 0,
        audit_id: data.meta.audit_id
      },
      'VTID-01085'
    );

    console.log(`[VTID-01085] Memory retrieve completed: ${totalSources} items, audit_id=${data.meta.audit_id}`);

    // Return the response from RPC
    return res.status(200).json(data);

  } catch (err: any) {
    console.error('[VTID-01085] memory_retrieve error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /health -> GET /api/v1/memory/health
 *
 * Health check for memory system.
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'memory-gateway',
    version: '1.0.0',
    vtid: 'VTID-01105',
    timestamp: new Date().toISOString(),
    capabilities: {
      write: hasSupabaseUrl && hasSupabaseKey,
      read: hasSupabaseUrl && hasSupabaseKey,
      retrieve: hasSupabaseUrl && hasSupabaseKey,
      auto_classify: true,
      category_keys: CATEGORY_KEYS,
      retrieve_intents: RETRIEVE_INTENTS,
      retrieve_modes: RETRIEVE_MODES
    },
    dependencies: {
      'VTID-01102': 'context_bridge',
      'VTID-01104': 'memory_rpc',
      'VTID-01085': 'memory_retrieve_router'
    }
  });
});

export default router;
