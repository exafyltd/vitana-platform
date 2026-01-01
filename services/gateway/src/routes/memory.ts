/**
 * VTID-01105: ORB Memory Wiring v1 (Gateway)
 * VTID-01082: Memory Garden Core + Daily Diary Ingestion (Phase D Foundation)
 * VTID-01085: Memory Retrieve Router v1 (Unified Memory Access)
 *
 * Memory write/read endpoints and auto-write hooks for ORB conversations.
 * Memory Garden diary and node extraction for personalization.
 *
 * Endpoints:
 * - POST /api/v1/memory/write        - Write a memory item (VTID-01105)
 * - GET  /api/v1/memory/context      - Fetch memory context (VTID-01105)
 * - GET  /api/v1/memory/health       - Health check
 * - POST /api/v1/memory/diary        - Add diary entry (VTID-01082)
 * - GET  /api/v1/memory/diary        - Get diary entries with date range (VTID-01082)
 * - POST /api/v1/memory/garden/extract - Extract garden nodes from diary entry (VTID-01082)
 * - GET  /api/v1/memory/garden/summary - Get garden summary (VTID-01082)
 * - POST /api/v1/memory/retrieve     - Unified memory retrieval gateway (VTID-01085)
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
// VTID-01091: Location extraction from diary entries
import { processLocationMentionsFromDiary } from './locations';

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
const SOURCE_TYPES = ['orb_text', 'orb_voice', 'diary', 'upload', 'system'] as const;
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

// =============================================================================
// VTID-01082: Diary Entry Schemas
// =============================================================================

/**
 * Valid diary entry types
 */
const DIARY_ENTRY_TYPES = ['free', 'guided', 'health', 'reflection'] as const;
type DiaryEntryType = typeof DIARY_ENTRY_TYPES[number];

/**
 * Diary entry write request schema
 */
const DiaryEntryWriteSchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'entry_date must be YYYY-MM-DD format'),
  entry_type: z.enum(DIARY_ENTRY_TYPES),
  raw_text: z.string().min(1, 'raw_text is required'),
  mood: z.string().optional().nullable(),
  energy_level: z.number().int().min(1).max(10).optional().nullable(),
  tags: z.array(z.string()).optional().default([])
});

type DiaryEntryWriteRequest = z.infer<typeof DiaryEntryWriteSchema>;

/**
 * Diary entries query parameters
 */
const DiaryEntriesQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

/**
 * Garden extract request schema
 */
const GardenExtractSchema = z.object({
  diary_entry_id: z.string().uuid('diary_entry_id must be a valid UUID')
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
 * Emit a memory-related OASIS event (VTID-01105)
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

/**
 * Emit a Memory Garden OASIS event (VTID-01082)
 * All events include: vtid, user_id, tenant_id, active_role
 */
async function emitMemoryGardenEvent(
  type: 'memory.diary.created' | 'memory.garden.extract.started' | 'memory.garden.node.created' | 'memory.garden.node.updated' | 'memory.garden.summary.read',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01082',
    type: type as any,
    source: 'memory-garden-gateway',
    status,
    message,
    payload
  }).catch(err => console.warn(`[VTID-01082] Failed to emit ${type}:`, err.message));
}

/**
 * VTID-01086: Emit a Memory Garden progress OASIS event
 */
async function emitGardenEvent(
  type: 'memory.garden.progress.read' | 'memory.garden.ui.refreshed' | 'memory.garden.longevity_panel.read',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01086',
    type: type as any,
    source: 'memory-gateway',
    status,
    message,
    payload
  }).catch(err => console.warn(`[VTID-01086] Failed to emit ${type}:`, err.message));
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

  // VTID-01091: Extract location mentions from diary entries
  let locationExtractionResult = null;
  if (source === 'diary') {
    try {
      locationExtractionResult = await processLocationMentionsFromDiary(
        token,
        content,
        occurred_at
      );
      if (locationExtractionResult.locations_created > 0 || locationExtractionResult.visits_created > 0) {
        console.log(`[VTID-01091] Diary location extraction: ${locationExtractionResult.locations_created} locations, ${locationExtractionResult.visits_created} visits`);
      }
    } catch (err: any) {
      console.warn('[VTID-01091] Diary location extraction failed (non-blocking):', err.message);
    }
  }

  return res.status(200).json({
    ok: true,
    id: result.id,
    category_key: result.category_key,
    occurred_at: result.occurred_at,
    ...(locationExtractionResult && {
      location_extraction: {
        locations_created: locationExtractionResult.locations_created,
        visits_created: locationExtractionResult.visits_created
      }
    })
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

// =============================================================================
// VTID-01086: Memory Garden Progress Endpoint
// =============================================================================

/**
 * GET /garden/progress -> GET /api/v1/memory/garden/progress
 *
 * Returns counts and progress per Memory Garden category.
 * Progress = min(1, count / target_count)
 */
router.get('/garden/progress', async (req: Request, res: Response) => {
  console.log('[VTID-01086] GET /memory/garden/progress');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
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

    // Call memory_get_garden_progress RPC
    const { data, error } = await supabase.rpc('memory_get_garden_progress');

    if (error) {
      // Check if RPC doesn't exist (migration not deployed yet)
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01086] memory_get_garden_progress RPC not found (migration not deployed yet)');
        // Return placeholder data for development
        return res.status(200).json({
          ok: true,
          totals: { memories: 0 },
          categories: {
            personal_identity: { count: 0, progress: 0.00, label: 'Personal Identity' },
            health_wellness: { count: 0, progress: 0.00, label: 'Health & Wellness' },
            lifestyle_routines: { count: 0, progress: 0.00, label: 'Lifestyle & Routines' },
            network_relationships: { count: 0, progress: 0.00, label: 'Network & Relationships' },
            learning_knowledge: { count: 0, progress: 0.00, label: 'Learning & Knowledge' },
            business_projects: { count: 0, progress: 0.00, label: 'Business & Projects' },
            finance_assets: { count: 0, progress: 0.00, label: 'Finance & Assets' },
            location_environment: { count: 0, progress: 0.00, label: 'Location & Environment' },
            digital_footprint: { count: 0, progress: 0.00, label: 'Digital Footprint' },
            values_aspirations: { count: 0, progress: 0.00, label: 'Values & Aspirations' },
            autopilot_context: { count: 0, progress: 0.00, label: 'Autopilot Context' },
            future_plans: { count: 0, progress: 0.00, label: 'Future Plans' },
            uncategorized: { count: 0, progress: 0.00, label: 'Uncategorized' }
          },
          _placeholder: true
        });
      }
      console.error('[VTID-01086] memory_get_garden_progress RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    // Get user context for OASIS event
    const { data: meData } = await supabase.rpc('me_context');
    const tenantId = meData?.tenant_id || null;
    const userId = meData?.user_id || meData?.id || null;
    const activeRole = meData?.active_role || null;

    // Emit OASIS event
    await emitGardenEvent(
      'memory.garden.progress.read',
      'success',
      `Memory Garden progress fetched: ${data?.totals?.memories || 0} total memories`,
      {
        tenant_id: tenantId,
        user_id: userId,
        active_role: activeRole,
        total_memories: data?.totals?.memories || 0,
        category_count: Object.keys(data?.categories || {}).length
      }
    );

    console.log(`[VTID-01086] Memory Garden progress fetched: ${data?.totals?.memories || 0} memories`);

    return res.status(200).json({
      ok: data?.ok ?? true,
      totals: data?.totals || { memories: 0 },
      categories: data?.categories || {}
    });
  } catch (err: any) {
    console.error('[VTID-01086] memory_get_garden_progress error:', err.message);
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
      retrieve_modes: RETRIEVE_MODES,
      diary: hasSupabaseUrl && hasSupabaseKey,
      garden: hasSupabaseUrl && hasSupabaseKey
    },
    dependencies: {
      'VTID-01102': 'context_bridge',
      'VTID-01104': 'memory_rpc',
      'VTID-01082': 'memory_garden_diary',
      'VTID-01085': 'memory_retrieve_router'
    }
  });
});

// =============================================================================
// VTID-01082: Diary Entry Routes
// =============================================================================

/**
 * POST /diary -> POST /api/v1/memory/diary
 *
 * Add a diary entry for the current user.
 */
router.post('/diary', async (req: Request, res: Response) => {
  console.log('[VTID-01082] POST /memory/diary');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = DiaryEntryWriteSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01082] Diary validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { entry_date, entry_type, raw_text, mood, energy_level, tags } = validation.data;

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

    // Call memory_add_diary_entry RPC
    const { data, error } = await supabase.rpc('memory_add_diary_entry', {
      p_entry_date: entry_date,
      p_entry_type: entry_type,
      p_raw_text: raw_text,
      p_mood: mood || null,
      p_energy_level: energy_level || null,
      p_tags: tags || []
    });

    if (error) {
      // Check if RPC doesn't exist
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01082] memory_add_diary_entry RPC not found (migration not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Diary RPC not available (VTID-01082 migration required)'
        });
      }
      console.error('[VTID-01082] memory_add_diary_entry RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    // Check for RPC-level errors
    if (data && data.ok === false) {
      console.warn('[VTID-01082] Diary entry RPC returned error:', data.error);
      return res.status(400).json({
        ok: false,
        error: data.error,
        message: data.message
      });
    }

    // Emit OASIS event: memory.diary.created
    await emitMemoryGardenEvent(
      'memory.diary.created',
      'success',
      `Diary entry created: ${entry_type} for ${entry_date}`,
      {
        diary_entry_id: data?.id,
        entry_date,
        entry_type,
        tenant_id: data?.tenant_id,
        user_id: data?.user_id,
        active_role: data?.active_role,
        raw_text_length: raw_text.length,
        has_mood: !!mood,
        has_energy_level: energy_level !== null && energy_level !== undefined,
        tags_count: tags?.length || 0
      }
    );

    console.log(`[VTID-01082] Diary entry created: ${data?.id} (${entry_type} for ${entry_date})`);

    return res.status(200).json({
      ok: true,
      id: data?.id,
      entry_date,
      entry_type
    });
  } catch (err: any) {
    console.error('[VTID-01082] Diary entry error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /diary -> GET /api/v1/memory/diary?from=&to=
 *
 * Get diary entries for the current user with optional date range.
 */
router.get('/diary', async (req: Request, res: Response) => {
  console.log('[VTID-01082] GET /memory/diary');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query parameters
  const queryValidation = DiaryEntriesQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid query parameters',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { from, to, limit } = queryValidation.data;

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

    // Call memory_get_diary_entries RPC
    const { data, error } = await supabase.rpc('memory_get_diary_entries', {
      p_from: from || null,
      p_to: to || null,
      p_limit: limit
    });

    if (error) {
      // Check if RPC doesn't exist
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01082] memory_get_diary_entries RPC not found (migration not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Diary RPC not available (VTID-01082 migration required)'
        });
      }
      console.error('[VTID-01082] memory_get_diary_entries RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    // Check for RPC-level errors
    if (data && data.ok === false) {
      console.warn('[VTID-01082] Get diary entries RPC returned error:', data.error);
      return res.status(400).json({
        ok: false,
        error: data.error,
        message: data.message
      });
    }

    console.log(`[VTID-01082] Diary entries fetched: ${data?.count || 0} entries`);

    return res.status(200).json({
      ok: true,
      entries: data?.entries || [],
      count: data?.count || 0,
      query: { from, to, limit }
    });
  } catch (err: any) {
    console.error('[VTID-01082] Get diary entries error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

// =============================================================================
// VTID-01082: Memory Garden Routes
// =============================================================================

/**
 * POST /garden/extract -> POST /api/v1/memory/garden/extract
 *
 * Extract garden nodes from a diary entry (deterministic, idempotent).
 */
router.post('/garden/extract', async (req: Request, res: Response) => {
  console.log('[VTID-01082] POST /memory/garden/extract');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = GardenExtractSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01082] Garden extract validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { diary_entry_id } = validation.data;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'Gateway misconfigured'
    });
  }

  // Emit OASIS event: memory.garden.extract.started
  await emitMemoryGardenEvent(
    'memory.garden.extract.started',
    'info',
    `Garden extraction started for diary entry: ${diary_entry_id}`,
    { diary_entry_id }
  );

  try {
    const supabase = createUserSupabaseClient(token);

    // Call memory_extract_garden_nodes RPC
    const { data, error } = await supabase.rpc('memory_extract_garden_nodes', {
      p_diary_entry_id: diary_entry_id
    });

    if (error) {
      // Check if RPC doesn't exist
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01082] memory_extract_garden_nodes RPC not found (migration not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Garden RPC not available (VTID-01082 migration required)'
        });
      }
      console.error('[VTID-01082] memory_extract_garden_nodes RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    // Check for RPC-level errors
    if (data && data.ok === false) {
      console.warn('[VTID-01082] Garden extract RPC returned error:', data.error);
      return res.status(400).json({
        ok: false,
        error: data.error,
        message: data.message
      });
    }

    // Emit OASIS events for created/updated nodes
    const nodesCreated = data?.nodes_created || 0;
    const nodesUpdated = data?.nodes_updated || 0;

    if (nodesCreated > 0) {
      await emitMemoryGardenEvent(
        'memory.garden.node.created',
        'success',
        `Created ${nodesCreated} garden node(s) from diary entry`,
        {
          diary_entry_id,
          nodes_created: nodesCreated,
          extracted_nodes: data?.extracted_nodes
        }
      );
    }

    if (nodesUpdated > 0) {
      await emitMemoryGardenEvent(
        'memory.garden.node.updated',
        'success',
        `Updated ${nodesUpdated} garden node(s) from diary entry`,
        {
          diary_entry_id,
          nodes_updated: nodesUpdated
        }
      );
    }

    console.log(`[VTID-01082] Garden extraction complete: ${nodesCreated} created, ${nodesUpdated} updated`);

    return res.status(200).json({
      ok: true,
      diary_entry_id,
      nodes_created: nodesCreated,
      nodes_updated: nodesUpdated,
      extracted_nodes: data?.extracted_nodes || []
    });
  } catch (err: any) {
    console.error('[VTID-01082] Garden extraction error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /garden/summary -> GET /api/v1/memory/garden/summary
 *
 * Get the Memory Garden summary for the current user.
 * This summary feeds Health, Community, Lifestyle, Business, and Autopilot.
 */
router.get('/garden/summary', async (req: Request, res: Response) => {
  console.log('[VTID-01082] GET /memory/garden/summary');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
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

    // Call memory_get_garden_summary RPC
    const { data, error } = await supabase.rpc('memory_get_garden_summary');

    if (error) {
      // Check if RPC doesn't exist
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01082] memory_get_garden_summary RPC not found (migration not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Garden RPC not available (VTID-01082 migration required)'
        });
      }
      console.error('[VTID-01082] memory_get_garden_summary RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    // Check for RPC-level errors
    if (data && data.ok === false) {
      console.warn('[VTID-01082] Garden summary RPC returned error:', data.error);
      return res.status(400).json({
        ok: false,
        error: data.error,
        message: data.message
      });
    }

    // Emit OASIS event: memory.garden.summary.read
    await emitMemoryGardenEvent(
      'memory.garden.summary.read',
      'success',
      'Garden summary fetched',
      {
        habits_count: data?.habits?.length || 0,
        health_signals_count: data?.health_signals?.length || 0,
        values_count: data?.values?.length || 0,
        goals_count: data?.goals?.length || 0,
        patterns_count: data?.patterns?.length || 0,
        confidence_score: data?.confidence_score
      }
    );

    console.log(`[VTID-01082] Garden summary fetched: confidence=${data?.confidence_score}`);

    // Return the garden summary in the contract format
    return res.status(200).json({
      ok: true,
      habits: data?.habits || [],
      health_signals: data?.health_signals || [],
      values: data?.values || [],
      goals: data?.goals || [],
      patterns: data?.patterns || [],
      confidence_score: data?.confidence_score || 0,
      last_updated: data?.last_updated || new Date().toISOString()
    });
  } catch (err: any) {
    console.error('[VTID-01082] Garden summary error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

export default router;
