/**
 * VTID-01088: Matchmaking Engine v1 (Gateway Routes)
 *
 * Deterministic matchmaking for People <-> People/Groups/Events/Services/Products/Locations/Live Rooms
 *
 * Endpoints:
 * - POST /recompute/daily     - Recompute daily matches for the current user
 * - GET  /daily               - Get daily matches (grouped by type)
 * - POST /:id/state           - Accept or dismiss a match
 * - GET  /health              - Health check
 *
 * Key Principles:
 * - All matches are DETERMINISTIC (no AI inference)
 * - All matches are EXPLAINABLE ("Why this match?")
 * - All matches are LONGEVITY-FOCUSED
 * - All matches are CONSENT-SAFE
 * - Recompute is IDEMPOTENT per day
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';
import { notifyUserAsync } from '../services/notification-service';

const router = Router();

// VTID for matchmaking-related OASIS events
const VTID = 'VTID-01088';

// =============================================================================
// VTID-01088: Types & Schemas
// =============================================================================

/**
 * Valid match states
 */
const MATCH_STATES = ['suggested', 'accepted', 'dismissed'] as const;
type MatchState = typeof MATCH_STATES[number];

/**
 * Valid match target types
 */
const MATCH_TARGET_TYPES = [
  'person',
  'group',
  'event',
  'service',
  'product',
  'location',
  'live_room'
] as const;
type MatchTargetType = typeof MATCH_TARGET_TYPES[number];

/**
 * Recompute daily request schema
 */
const RecomputeDailyRequestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional()
});

/**
 * Get daily matches query schema
 */
const GetDailyQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional()
});

/**
 * Set match state request schema
 */
const SetStateRequestSchema = z.object({
  state: z.enum(MATCH_STATES)
});

// =============================================================================
// VTID-01088: Helper Functions
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
 * Emit a matchmaking-related OASIS event
 */
async function emitMatchEvent(
  eventType:
    | 'match.compute.requested'
    | 'match.compute.completed'
    | 'match.daily.read'
    | 'match.state.updated'
    | 'match.accepted.relationship.created'
    | 'match.compute.error'
    | 'match.state.error',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: eventType as any,
      source: 'gateway-matchmaking',
      status,
      message,
      payload: {
        ...payload,
        timestamp: new Date().toISOString()
      }
    });
    console.log(`[${VTID}] OASIS event emitted: ${eventType}`);
  } catch (err: any) {
    console.warn(`[${VTID}] Failed to emit OASIS event ${eventType}:`, err.message);
  }
}

/**
 * Get current date in YYYY-MM-DD format
 */
function getCurrentDate(): string {
  return new Date().toISOString().split('T')[0];
}

// =============================================================================
// VTID-01088: Routes
// =============================================================================

/**
 * POST /recompute/daily -> POST /api/v1/match/recompute/daily
 *
 * Recompute daily matches for the current user.
 * This is idempotent - calling multiple times for the same date will
 * replace existing suggested matches but preserve accepted/dismissed states.
 *
 * Request body:
 * - date?: string (YYYY-MM-DD format, defaults to today)
 *
 * Response:
 * {
 *   ok: true,
 *   user_id: string,
 *   date: string,
 *   counts: { person: number, group: number, ... },
 *   user_topics: string[],
 *   rule_version: string
 * }
 */
router.post('/recompute/daily', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /match/recompute/daily`);

  const token = getBearerToken(req);
  if (!token) {
    console.warn(`[${VTID}] POST /match/recompute/daily - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const validation = RecomputeDailyRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] POST /match/recompute/daily - Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const matchDate = validation.data.date || getCurrentDate();
  const startTime = Date.now();

  // Emit compute requested event
  await emitMatchEvent(
    'match.compute.requested',
    'info',
    `Match recompute requested for ${matchDate}`,
    { date: matchDate }
  );

  try {
    const supabase = createUserSupabaseClient(token);

    // Call RPC function
    const { data, error } = await supabase.rpc('match_recompute_daily', {
      p_user_id: null, // Will use auth.uid() in RPC
      p_date: matchDate
    });

    if (error) {
      console.error(`[${VTID}] POST /match/recompute/daily - RPC error:`, error.message);

      // Check for known error types
      if (error.message.includes('UNAUTHENTICATED') || error.message.includes('JWT')) {
        return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      }
      if (error.message.includes('TENANT_NOT_FOUND')) {
        return res.status(403).json({ ok: false, error: 'TENANT_NOT_FOUND' });
      }

      // Check if RPC doesn't exist (migration not deployed)
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn(`[${VTID}] match_recompute_daily RPC not found (migration not deployed)`);
        await emitMatchEvent(
          'match.compute.error',
          'error',
          'Match RPC not available (migration dependency)',
          { date: matchDate, error: error.message }
        );
        return res.status(503).json({
          ok: false,
          error: 'SERVICE_UNAVAILABLE',
          message: 'Matchmaking RPC not available (VTID-01088 migration required)'
        });
      }

      await emitMatchEvent(
        'match.compute.error',
        'error',
        `Match recompute failed: ${error.message}`,
        { date: matchDate, error: error.message }
      );

      return res.status(502).json({ ok: false, error: 'UPSTREAM_ERROR', message: error.message });
    }

    // Check RPC result
    if (!data?.ok) {
      console.error(`[${VTID}] POST /match/recompute/daily - RPC returned error:`, data);
      await emitMatchEvent(
        'match.compute.error',
        'error',
        `Match recompute failed: ${data?.error || 'Unknown error'}`,
        { date: matchDate, result: data }
      );
      return res.status(400).json({
        ok: false,
        error: data?.error || 'COMPUTE_FAILED',
        message: data?.message || 'Failed to recompute matches'
      });
    }

    const elapsed = Date.now() - startTime;
    const totalMatches = Object.values(data.counts as Record<string, number> || {})
      .reduce((sum: number, count: number) => sum + count, 0);

    // Emit compute completed event
    await emitMatchEvent(
      'match.compute.completed',
      'success',
      `Match recompute completed: ${totalMatches} matches generated`,
      {
        date: matchDate,
        counts: data.counts,
        user_id: data.user_id,
        tenant_id: data.tenant_id,
        total_matches: totalMatches,
        top_topics: (data.user_topics || []).slice(0, 5),
        elapsed_ms: elapsed
      }
    );

    console.log(`[${VTID}] POST /match/recompute/daily - Success: ${totalMatches} matches in ${elapsed}ms`);

    // Notify user about new matches
    if (totalMatches > 0 && data.user_id && data.tenant_id) {
      const { createClient } = await import('@supabase/supabase-js');
      const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
      notifyUserAsync(data.user_id, data.tenant_id, 'new_daily_matches', {
        title: `${totalMatches} new matches today!`,
        body: 'Check out who you matched with today.',
        data: { url: '/discover', match_count: String(totalMatches) },
      }, supa);
    }

    return res.status(200).json({
      ok: true,
      user_id: data.user_id,
      date: matchDate,
      counts: data.counts || {},
      user_topics: data.user_topics || [],
      rule_version: data.rule_version || 'v1',
      elapsed_ms: elapsed
    });
  } catch (err: any) {
    console.error(`[${VTID}] POST /match/recompute/daily - Unexpected error:`, err.message);
    await emitMatchEvent(
      'match.compute.error',
      'error',
      `Match recompute error: ${err.message}`,
      { date: matchDate, error: err.message }
    );
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /daily -> GET /api/v1/match/daily
 *
 * Get daily matches for the current user, grouped by type.
 * Includes privacy-safe previews for person matches.
 *
 * Query params:
 * - date?: string (YYYY-MM-DD format, defaults to today)
 *
 * Response:
 * {
 *   ok: true,
 *   user_id: string,
 *   date: string,
 *   matches: {
 *     person: [...],
 *     group: [...],
 *     event: [...],
 *     ...
 *   }
 * }
 */
router.get('/daily', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /match/daily`);

  const token = getBearerToken(req);
  if (!token) {
    console.warn(`[${VTID}] GET /match/daily - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate query params
  const validation = GetDailyQuerySchema.safeParse(req.query);
  if (!validation.success) {
    console.warn(`[${VTID}] GET /match/daily - Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const matchDate = validation.data.date || getCurrentDate();

  try {
    const supabase = createUserSupabaseClient(token);

    // Call RPC function
    const { data, error } = await supabase.rpc('match_get_daily', {
      p_user_id: null, // Will use auth.uid() in RPC
      p_date: matchDate
    });

    if (error) {
      console.error(`[${VTID}] GET /match/daily - RPC error:`, error.message);

      if (error.message.includes('UNAUTHENTICATED') || error.message.includes('JWT')) {
        return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      }
      if (error.message.includes('TENANT_NOT_FOUND')) {
        return res.status(403).json({ ok: false, error: 'TENANT_NOT_FOUND' });
      }

      // Check if RPC doesn't exist
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn(`[${VTID}] match_get_daily RPC not found (migration not deployed)`);
        return res.status(503).json({
          ok: false,
          error: 'SERVICE_UNAVAILABLE',
          message: 'Matchmaking RPC not available (VTID-01088 migration required)'
        });
      }

      return res.status(502).json({ ok: false, error: 'UPSTREAM_ERROR', message: error.message });
    }

    if (!data?.ok) {
      console.error(`[${VTID}] GET /match/daily - RPC returned error:`, data);
      return res.status(400).json({
        ok: false,
        error: data?.error || 'FETCH_FAILED'
      });
    }

    // Calculate total matches for logging
    const totalMatches = Object.values(data.matches as Record<string, any[]> || {})
      .reduce((sum: number, arr: any[]) => sum + (arr?.length || 0), 0);

    // Emit read event
    await emitMatchEvent(
      'match.daily.read',
      'success',
      `Daily matches read: ${totalMatches} matches`,
      {
        date: matchDate,
        user_id: data.user_id,
        total_matches: totalMatches,
        match_types: Object.keys(data.matches || {})
      }
    );

    console.log(`[${VTID}] GET /match/daily - Success: ${totalMatches} matches for ${matchDate}`);

    return res.status(200).json({
      ok: true,
      user_id: data.user_id,
      date: matchDate,
      matches: data.matches || {}
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /match/daily - Unexpected error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /:id/state -> POST /api/v1/match/:id/state
 *
 * Accept or dismiss a match.
 * If accepted, creates a relationship edge (VTID-01087).
 *
 * Path params:
 * - id: UUID of the match
 *
 * Request body:
 * - state: 'accepted' | 'dismissed' | 'suggested'
 *
 * Response:
 * {
 *   ok: true,
 *   match_id: string,
 *   state: string,
 *   edge_created?: boolean,
 *   edge_id?: string
 * }
 */
router.post('/:id/state', async (req: Request, res: Response) => {
  const matchId = req.params.id;
  console.log(`[${VTID}] POST /match/${matchId}/state`);

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(matchId)) {
    console.warn(`[${VTID}] POST /match/:id/state - Invalid match ID format`);
    return res.status(400).json({ ok: false, error: 'INVALID_MATCH_ID' });
  }

  const token = getBearerToken(req);
  if (!token) {
    console.warn(`[${VTID}] POST /match/:id/state - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const validation = SetStateRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] POST /match/:id/state - Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const newState = validation.data.state;

  try {
    const supabase = createUserSupabaseClient(token);

    // Call RPC function
    const { data, error } = await supabase.rpc('match_set_state', {
      p_match_id: matchId,
      p_state: newState
    });

    if (error) {
      console.error(`[${VTID}] POST /match/:id/state - RPC error:`, error.message);

      if (error.message.includes('UNAUTHENTICATED') || error.message.includes('JWT')) {
        return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      }
      if (error.message.includes('TENANT_NOT_FOUND')) {
        return res.status(403).json({ ok: false, error: 'TENANT_NOT_FOUND' });
      }

      // Check if RPC doesn't exist
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn(`[${VTID}] match_set_state RPC not found (migration not deployed)`);
        return res.status(503).json({
          ok: false,
          error: 'SERVICE_UNAVAILABLE',
          message: 'Matchmaking RPC not available (VTID-01088 migration required)'
        });
      }

      await emitMatchEvent(
        'match.state.error',
        'error',
        `Match state update failed: ${error.message}`,
        { match_id: matchId, state: newState, error: error.message }
      );

      return res.status(502).json({ ok: false, error: 'UPSTREAM_ERROR', message: error.message });
    }

    if (!data?.ok) {
      console.error(`[${VTID}] POST /match/:id/state - RPC returned error:`, data);

      if (data?.error === 'MATCH_NOT_FOUND') {
        return res.status(404).json({ ok: false, error: 'MATCH_NOT_FOUND' });
      }

      await emitMatchEvent(
        'match.state.error',
        'error',
        `Match state update failed: ${data?.error || 'Unknown error'}`,
        { match_id: matchId, state: newState, result: data }
      );

      return res.status(400).json({
        ok: false,
        error: data?.error || 'UPDATE_FAILED'
      });
    }

    // Emit state updated event
    await emitMatchEvent(
      'match.state.updated',
      'success',
      `Match state updated: ${newState}`,
      {
        match_id: matchId,
        state: newState,
        edge_created: data.edge_created || false,
        edge_id: data.edge_id || null
      }
    );

    // If edge was created, emit additional event
    if (data.edge_created && data.edge_id) {
      await emitMatchEvent(
        'match.accepted.relationship.created',
        'success',
        `Relationship edge created from accepted match`,
        {
          match_id: matchId,
          edge_id: data.edge_id,
          origin: 'autopilot'
        }
      );
    }

    console.log(`[${VTID}] POST /match/:id/state - Success: ${matchId} -> ${newState}`);

    // Notify users when a match is accepted
    if (newState === 'accepted') {
      try {
        let acceptorId = '';
        try { acceptorId = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub; } catch {}

        // Query match to get both users and tenant
        const { data: match } = await supabase
          .from('user_matches')
          .select('user_id, matched_user_id, tenant_id')
          .eq('id', matchId)
          .single();

        if (match?.tenant_id && acceptorId) {
          const otherUserId = acceptorId === match.user_id ? match.matched_user_id : match.user_id;

          // Notify the OTHER user that their match was accepted
          if (otherUserId) {
            notifyUserAsync(otherUserId, match.tenant_id, 'match_accepted_by_other', {
              title: 'Match Accepted!',
              body: 'Someone accepted your match. Start a conversation!',
              data: { url: '/discover', match_id: matchId, entity_id: matchId },
            }, supabase);
          }

          // Confirm to the acceptor
          notifyUserAsync(acceptorId, match.tenant_id, 'your_match_accepted', {
            title: 'Match Confirmed',
            body: 'Your match is confirmed! You can now connect.',
            data: { url: '/discover', match_id: matchId, entity_id: matchId },
          }, supabase);
        }
      } catch (err: any) {
        console.warn(`[Notifications] match_accepted dispatch error: ${err.message}`);
      }
    }

    return res.status(200).json({
      ok: true,
      match_id: matchId,
      state: newState,
      edge_created: data.edge_created || false,
      edge_id: data.edge_id || undefined
    });
  } catch (err: any) {
    console.error(`[${VTID}] POST /match/:id/state - Unexpected error:`, err.message);
    await emitMatchEvent(
      'match.state.error',
      'error',
      `Match state update error: ${err.message}`,
      { match_id: matchId, state: newState, error: err.message }
    );
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET / -> GET /api/v1/match
 *
 * Health check and status for matchmaking service.
 */
router.get('/', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'matchmaking-gateway',
    vtid: VTID,
    version: 'v1',
    endpoints: [
      'POST /api/v1/match/recompute/daily',
      'GET /api/v1/match/daily?date=YYYY-MM-DD',
      'POST /api/v1/match/:id/state'
    ],
    match_types: MATCH_TARGET_TYPES,
    match_states: MATCH_STATES,
    features: [
      'Deterministic scoring (no AI)',
      'Explainable matches ("Why this match?")',
      'Longevity-focused matching',
      'Privacy-safe person previews',
      'Relationship edge creation on accept'
    ],
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /health -> GET /api/v1/match/health
 *
 * Health check for the matchmaking service.
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'matchmaking-gateway',
    version: 'v1',
    vtid: VTID,
    timestamp: new Date().toISOString(),
    capabilities: {
      recompute: hasSupabaseUrl && hasSupabaseKey,
      read: hasSupabaseUrl && hasSupabaseKey,
      state_update: hasSupabaseUrl && hasSupabaseKey
    },
    dependencies: {
      'VTID-01087': 'relationship_graph (relationship_edges table)',
      'VTID-01104': 'memory_core (memory_items for topic extraction)',
      'VTID-01103': 'health_compute (vitana_index_scores for longevity signals)'
    }
  });
});

export default router;
