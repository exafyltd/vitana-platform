/**
 * VTID-01087: Relationship Graph Memory Gateway Routes
 *
 * Universal relationship memory graph endpoints for matchmaking spine.
 *
 * Endpoints:
 * - POST /api/v1/relationships/node       - Ensure a node exists
 * - POST /api/v1/relationships/edge       - Add/strengthen a relationship edge
 * - GET  /api/v1/relationships/graph      - Get filtered relationship graph
 * - GET  /api/v1/relationships/signals    - Get user behavioral signals
 * - POST /api/v1/relationships/signal     - Update a user signal
 * - GET  /api/v1/relationships/recommendations - Get matchmaking recommendations
 * - GET  /api/v1/relationships/health     - Health check
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
// VTID-01087: Constants & Types
// =============================================================================

/**
 * Valid node types for relationship entities
 */
const NODE_TYPES = [
  'person',
  'group',
  'event',
  'service',
  'product',
  'location',
  'live_room'
] as const;

type NodeType = typeof NODE_TYPES[number];

/**
 * Valid domains for categorization
 */
const DOMAINS = ['community', 'health', 'business', 'lifestyle'] as const;
type Domain = typeof DOMAINS[number];

/**
 * Valid relationship types
 */
const RELATIONSHIP_TYPES = [
  'friend',
  'member',
  'attendee',
  'interested',
  'using',
  'visited',
  'following'
] as const;

type RelationshipType = typeof RELATIONSHIP_TYPES[number];

/**
 * Valid origin types for relationships
 */
const ORIGIN_TYPES = ['diary', 'explicit', 'system', 'autopilot'] as const;
type OriginType = typeof ORIGIN_TYPES[number];

/**
 * Edge structure from graph query
 */
interface RelationshipEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
  relationship_type: string;
  strength: number;
  origin: string;
  context: Record<string, unknown>;
  first_seen: string;
  last_seen: string;
}

/**
 * Node structure from graph query
 */
interface RelationshipNode {
  id: string;
  node_type: string;
  ref_id: string | null;
  title: string;
  domain: string;
  metadata: Record<string, unknown>;
}

/**
 * Signal structure from signals query
 */
interface RelationshipSignal {
  id: string;
  signal_key: string;
  confidence: number;
  evidence: Record<string, unknown>;
  updated_at: string;
}

// =============================================================================
// VTID-01087: Request Schemas
// =============================================================================

/**
 * Ensure node request schema
 */
const EnsureNodeRequestSchema = z.object({
  node_type: z.enum(NODE_TYPES),
  title: z.string().min(1, 'Title is required'),
  ref_id: z.string().uuid().optional(),
  domain: z.enum(DOMAINS).default('community'),
  metadata: z.record(z.unknown()).optional().default({})
});

/**
 * Add edge request schema
 */
const AddEdgeRequestSchema = z.object({
  from_node_id: z.string().uuid('from_node_id must be a valid UUID'),
  to_node_id: z.string().uuid('to_node_id must be a valid UUID'),
  relationship_type: z.enum(RELATIONSHIP_TYPES),
  origin: z.enum(ORIGIN_TYPES),
  context: z.record(z.unknown()).optional().default({})
});

/**
 * Graph query parameters schema
 */
const GraphQuerySchema = z.object({
  domain: z.enum(DOMAINS).optional(),
  node_types: z.string().optional(), // comma-separated
  relationship_types: z.string().optional(), // comma-separated
  min_strength: z.coerce.number().int().min(0).max(100).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

/**
 * Signals query parameters schema
 */
const SignalsQuerySchema = z.object({
  min_confidence: z.coerce.number().int().min(0).max(100).default(0),
  signal_keys: z.string().optional() // comma-separated
});

/**
 * Update signal request schema
 */
const UpdateSignalRequestSchema = z.object({
  signal_key: z.string().min(1, 'signal_key is required'),
  confidence: z.number().int().min(0).max(100),
  evidence: z.record(z.unknown()).optional().default({})
});

// =============================================================================
// VTID-01087: Helper Functions
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
 * Emit a relationship-related OASIS event
 */
async function emitRelationshipEvent(
  type: 'relationship.edge.created' | 'relationship.edge.strengthened' | 'relationship.graph.read' | 'relationship.recommendation.generated' | 'relationship.signal.updated' | 'relationship.node.created',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01087',
    type: type as any,
    source: 'relationship-gateway',
    status,
    message,
    payload
  }).catch(err => console.warn(`[VTID-01087] Failed to emit ${type}:`, err.message));
}

// =============================================================================
// VTID-01087: Routes
// =============================================================================

/**
 * POST /node -> POST /api/v1/relationships/node
 *
 * Ensure a relationship node exists (get or create).
 */
router.post('/node', async (req: Request, res: Response) => {
  console.log('[VTID-01087] POST /relationships/node');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = EnsureNodeRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01087] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { node_type, title, ref_id, domain, metadata } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);

    // Call relationship_ensure_node RPC
    const { data, error } = await supabase.rpc('relationship_ensure_node', {
      p_node_type: node_type,
      p_title: title,
      p_ref_id: ref_id || null,
      p_domain: domain,
      p_metadata: metadata
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01087] relationship_ensure_node RPC not found (migration not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Relationship RPC not available (VTID-01087 dependency)'
        });
      }
      console.error('[VTID-01087] relationship_ensure_node RPC error:', error.message);
      return res.status(502).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit OASIS event if node was created
    if (data.created) {
      await emitRelationshipEvent(
        'relationship.node.created',
        'success',
        `Node created: ${node_type} - ${title}`,
        {
          node_id: data.id,
          node_type,
          title,
          domain,
          ref_id: ref_id || null
        }
      );
    }

    console.log(`[VTID-01087] Node ensured: ${data.id} (created: ${data.created})`);

    return res.status(200).json({
      ok: true,
      id: data.id,
      created: data.created
    });
  } catch (err: any) {
    console.error('[VTID-01087] ensure_node error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /edge -> POST /api/v1/relationships/edge
 *
 * Add or strengthen a relationship edge.
 */
router.post('/edge', async (req: Request, res: Response) => {
  console.log('[VTID-01087] POST /relationships/edge');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = AddEdgeRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01087] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { from_node_id, to_node_id, relationship_type, origin, context } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);

    // Call relationship_add_edge RPC
    const { data, error } = await supabase.rpc('relationship_add_edge', {
      p_from_node_id: from_node_id,
      p_to_node_id: to_node_id,
      p_relationship_type: relationship_type,
      p_origin: origin,
      p_context: context
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01087] relationship_add_edge RPC not found (migration not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Relationship RPC not available (VTID-01087 dependency)'
        });
      }
      console.error('[VTID-01087] relationship_add_edge RPC error:', error.message);
      return res.status(502).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit appropriate OASIS event
    const eventType = data.created ? 'relationship.edge.created' : 'relationship.edge.strengthened';
    await emitRelationshipEvent(
      eventType,
      'success',
      data.created
        ? `Relationship created: ${data.from_node?.title} -> ${data.to_node?.title}`
        : `Relationship strengthened: ${data.from_node?.title} -> ${data.to_node?.title} (strength: ${data.strength})`,
      {
        edge_id: data.edge_id,
        from_node: data.from_node,
        to_node: data.to_node,
        relationship_type,
        strength: data.strength,
        origin,
        created: data.created
      }
    );

    console.log(`[VTID-01087] Edge ${data.created ? 'created' : 'strengthened'}: ${data.edge_id} (strength: ${data.strength})`);

    return res.status(200).json({
      ok: true,
      edge_id: data.edge_id,
      created: data.created,
      strength: data.strength,
      from_node: data.from_node,
      to_node: data.to_node
    });
  } catch (err: any) {
    console.error('[VTID-01087] add_edge error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /graph -> GET /api/v1/relationships/graph
 *
 * Get filtered relationship graph for the current user.
 */
router.get('/graph', async (req: Request, res: Response) => {
  console.log('[VTID-01087] GET /relationships/graph');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query parameters
  const queryValidation = GraphQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid query parameters',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { domain, node_types, relationship_types, min_strength, limit } = queryValidation.data;

  // Parse comma-separated arrays
  let nodeTypesArray: string[] | null = null;
  if (node_types) {
    nodeTypesArray = node_types.split(',').map(t => t.trim()).filter(t => t.length > 0);
    for (const nt of nodeTypesArray) {
      if (!NODE_TYPES.includes(nt as NodeType)) {
        return res.status(400).json({
          ok: false,
          error: `Invalid node_type: ${nt}. Valid types: ${NODE_TYPES.join(', ')}`
        });
      }
    }
  }

  let relationshipTypesArray: string[] | null = null;
  if (relationship_types) {
    relationshipTypesArray = relationship_types.split(',').map(t => t.trim()).filter(t => t.length > 0);
    for (const rt of relationshipTypesArray) {
      if (!RELATIONSHIP_TYPES.includes(rt as RelationshipType)) {
        return res.status(400).json({
          ok: false,
          error: `Invalid relationship_type: ${rt}. Valid types: ${RELATIONSHIP_TYPES.join(', ')}`
        });
      }
    }
  }

  try {
    const supabase = createUserSupabaseClient(token);

    // Call relationship_get_graph RPC
    const { data, error } = await supabase.rpc('relationship_get_graph', {
      p_domain: domain || null,
      p_node_types: nodeTypesArray,
      p_relationship_types: relationshipTypesArray,
      p_min_strength: min_strength,
      p_limit: limit
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01087] relationship_get_graph RPC not found (migration not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Relationship RPC not available (VTID-01087 dependency)'
        });
      }
      console.error('[VTID-01087] relationship_get_graph RPC error:', error.message);
      return res.status(502).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit OASIS event
    await emitRelationshipEvent(
      'relationship.graph.read',
      'success',
      `Graph fetched: ${data.edges?.length || 0} edges, ${data.nodes?.length || 0} nodes`,
      {
        domain: domain || null,
        node_types: nodeTypesArray,
        relationship_types: relationshipTypesArray,
        min_strength,
        limit,
        edges_count: data.edges?.length || 0,
        nodes_count: data.nodes?.length || 0
      }
    );

    console.log(`[VTID-01087] Graph fetched: ${data.edges?.length || 0} edges, ${data.nodes?.length || 0} nodes`);

    return res.status(200).json({
      ok: true,
      edges: data.edges || [],
      nodes: data.nodes || [],
      query: data.query
    });
  } catch (err: any) {
    console.error('[VTID-01087] get_graph error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /signals -> GET /api/v1/relationships/signals
 *
 * Get user behavioral signals.
 */
router.get('/signals', async (req: Request, res: Response) => {
  console.log('[VTID-01087] GET /relationships/signals');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query parameters
  const queryValidation = SignalsQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid query parameters',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { min_confidence, signal_keys } = queryValidation.data;

  // Parse comma-separated signal keys
  let signalKeysArray: string[] | null = null;
  if (signal_keys) {
    signalKeysArray = signal_keys.split(',').map(k => k.trim()).filter(k => k.length > 0);
  }

  try {
    const supabase = createUserSupabaseClient(token);

    // Call relationship_get_signals RPC
    const { data, error } = await supabase.rpc('relationship_get_signals', {
      p_min_confidence: min_confidence,
      p_signal_keys: signalKeysArray
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01087] relationship_get_signals RPC not found (migration not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Relationship RPC not available (VTID-01087 dependency)'
        });
      }
      console.error('[VTID-01087] relationship_get_signals RPC error:', error.message);
      return res.status(502).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    console.log(`[VTID-01087] Signals fetched: ${data.signals?.length || 0} signals`);

    return res.status(200).json({
      ok: true,
      signals: data.signals || []
    });
  } catch (err: any) {
    console.error('[VTID-01087] get_signals error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /signal -> POST /api/v1/relationships/signal
 *
 * Update a user behavioral signal.
 */
router.post('/signal', async (req: Request, res: Response) => {
  console.log('[VTID-01087] POST /relationships/signal');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = UpdateSignalRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01087] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { signal_key, confidence, evidence } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);

    // Call relationship_update_signal RPC
    const { data, error } = await supabase.rpc('relationship_update_signal', {
      p_signal_key: signal_key,
      p_confidence: confidence,
      p_evidence: evidence
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01087] relationship_update_signal RPC not found (migration not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Relationship RPC not available (VTID-01087 dependency)'
        });
      }
      console.error('[VTID-01087] relationship_update_signal RPC error:', error.message);
      return res.status(502).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit OASIS event
    await emitRelationshipEvent(
      'relationship.signal.updated',
      'success',
      `Signal ${data.created ? 'created' : 'updated'}: ${signal_key} (confidence: ${confidence})`,
      {
        signal_id: data.signal_id,
        signal_key,
        confidence,
        created: data.created
      }
    );

    console.log(`[VTID-01087] Signal ${data.created ? 'created' : 'updated'}: ${signal_key} (confidence: ${confidence})`);

    return res.status(200).json({
      ok: true,
      signal_id: data.signal_id,
      signal_key: data.signal_key,
      confidence: data.confidence,
      created: data.created
    });
  } catch (err: any) {
    console.error('[VTID-01087] update_signal error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /recommendations -> GET /api/v1/relationships/recommendations
 *
 * Get matchmaking recommendations based on relationship graph and signals.
 * v1: Simple rules-based recommendations.
 */
router.get('/recommendations', async (req: Request, res: Response) => {
  console.log('[VTID-01087] GET /relationships/recommendations');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    // Get user's signals
    const { data: signalsData, error: signalsError } = await supabase.rpc('relationship_get_signals', {
      p_min_confidence: 30,
      p_signal_keys: null
    });

    if (signalsError) {
      if (signalsError.message.includes('function') && signalsError.message.includes('does not exist')) {
        console.warn('[VTID-01087] relationship_get_signals RPC not found (migration not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Relationship RPC not available (VTID-01087 dependency)'
        });
      }
    }

    // Get user's relationship graph
    const { data: graphData, error: graphError } = await supabase.rpc('relationship_get_graph', {
      p_domain: null,
      p_node_types: null,
      p_relationship_types: null,
      p_min_strength: 20,
      p_limit: 50
    });

    if (graphError) {
      if (graphError.message.includes('function') && graphError.message.includes('does not exist')) {
        console.warn('[VTID-01087] relationship_get_graph RPC not found (migration not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Relationship RPC not available (VTID-01087 dependency)'
        });
      }
    }

    // v1 Rules-based recommendation engine
    const recommendations: Array<{
      type: 'group' | 'event' | 'person' | 'service' | 'product';
      reason: string;
      confidence: number;
      metadata: Record<string, unknown>;
    }> = [];

    const signals: RelationshipSignal[] = signalsData?.signals || [];
    const edges: RelationshipEdge[] = graphData?.edges || [];
    const nodes: RelationshipNode[] = graphData?.nodes || [];

    // Build signal map for quick lookup
    const signalMap = new Map<string, number>();
    for (const signal of signals) {
      signalMap.set(signal.signal_key, signal.confidence);
    }

    // Count relationship types
    const relationshipCounts: Record<string, number> = {};
    const nodeTypeCounts: Record<string, number> = {};

    for (const edge of edges) {
      relationshipCounts[edge.relationship_type] = (relationshipCounts[edge.relationship_type] || 0) + 1;
    }

    for (const node of nodes) {
      nodeTypeCounts[node.node_type] = (nodeTypeCounts[node.node_type] || 0) + 1;
    }

    // Rule 1: Low group connections + prefers_small_groups signal -> recommend small group
    const groupMemberCount = relationshipCounts['member'] || 0;
    const prefersSmallGroups = signalMap.get('prefers_small_groups') || 0;
    if (groupMemberCount < 3 && prefersSmallGroups > 50) {
      recommendations.push({
        type: 'group',
        reason: 'You seem to prefer small groups. Consider joining a small interest-based group.',
        confidence: Math.min(90, 50 + prefersSmallGroups / 2),
        metadata: {
          current_groups: groupMemberCount,
          signal: 'prefers_small_groups'
        }
      });
    }

    // Rule 2: Outdoor/walking preference signal -> recommend walking meetup
    const likesWalking = signalMap.get('likes_walking_meetups') || 0;
    const outdoorPreference = signalMap.get('prefers_outdoor') || 0;
    if (likesWalking > 40 || outdoorPreference > 40) {
      recommendations.push({
        type: 'event',
        reason: 'Based on your outdoor preferences, you might enjoy a walking meetup or outdoor activity.',
        confidence: Math.max(likesWalking, outdoorPreference),
        metadata: {
          signals: ['likes_walking_meetups', 'prefers_outdoor']
        }
      });
    }

    // Rule 3: Strong person connections (strength > 50) -> suggest 1-on-1 activity
    const strongFriends = edges.filter(e => e.relationship_type === 'friend' && e.strength > 50);
    if (strongFriends.length > 0 && strongFriends.length < 3) {
      recommendations.push({
        type: 'person',
        reason: 'You have strong connections. Consider planning a 1-on-1 activity with a close friend.',
        confidence: 70,
        metadata: {
          strong_connections: strongFriends.length
        }
      });
    }

    // Rule 4: Active event attendance -> suggest similar events
    const eventAttendance = relationshipCounts['attendee'] || 0;
    if (eventAttendance >= 2) {
      recommendations.push({
        type: 'event',
        reason: 'You actively attend events. Check out similar upcoming events in your area.',
        confidence: 60 + Math.min(30, eventAttendance * 5),
        metadata: {
          events_attended: eventAttendance
        }
      });
    }

    // Rule 5: Using services/products -> cross-recommend related items
    const usingCount = relationshipCounts['using'] || 0;
    if (usingCount >= 1) {
      recommendations.push({
        type: 'service',
        reason: 'Based on products/services you use, here are related recommendations.',
        confidence: 50,
        metadata: {
          current_usage: usingCount
        }
      });
    }

    // Sort by confidence
    recommendations.sort((a, b) => b.confidence - a.confidence);

    // Emit OASIS event
    await emitRelationshipEvent(
      'relationship.recommendation.generated',
      'success',
      `Generated ${recommendations.length} recommendations`,
      {
        recommendations_count: recommendations.length,
        signals_used: signals.length,
        edges_analyzed: edges.length
      }
    );

    console.log(`[VTID-01087] Generated ${recommendations.length} recommendations`);

    return res.status(200).json({
      ok: true,
      recommendations,
      context: {
        signals_count: signals.length,
        edges_count: edges.length,
        nodes_count: nodes.length
      }
    });
  } catch (err: any) {
    console.error('[VTID-01087] recommendations error:', err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /health -> GET /api/v1/relationships/health
 *
 * Health check for relationship graph system.
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'relationship-gateway',
    version: '1.0.0',
    vtid: 'VTID-01087',
    timestamp: new Date().toISOString(),
    capabilities: {
      nodes: hasSupabaseUrl && hasSupabaseKey,
      edges: hasSupabaseUrl && hasSupabaseKey,
      signals: hasSupabaseUrl && hasSupabaseKey,
      graph: hasSupabaseUrl && hasSupabaseKey,
      recommendations: hasSupabaseUrl && hasSupabaseKey,
      node_types: NODE_TYPES,
      relationship_types: RELATIONSHIP_TYPES,
      domains: DOMAINS,
      origin_types: ORIGIN_TYPES
    },
    dependencies: {
      'VTID-01101': 'context_bridge',
      'VTID-01104': 'memory_core'
    }
  });
});

export default router;
