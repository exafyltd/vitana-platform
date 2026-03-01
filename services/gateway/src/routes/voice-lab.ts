/**
 * VTID-01218A: Voice LAB API Routes
 *
 * Query APIs for ORB Live session observability and debugging.
 *
 * Endpoints:
 * - GET /api/v1/voice-lab/live/sessions              - List live sessions
 * - GET /api/v1/voice-lab/live/sessions/:sessionId   - Get session details
 * - GET /api/v1/voice-lab/live/sessions/:sessionId/turns - Get session turns
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';

const router = Router();

// =============================================================================
// Types & Schemas
// =============================================================================

/**
 * VTID-01218A: Live session summary for list view
 */
interface LiveSessionSummary {
  session_id: string;
  status: 'active' | 'ended';
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  turn_count: number;
  audio_in_chunks: number;
  audio_out_chunks: number;
  lang?: string;
  transport: 'websocket' | 'sse';
  error_count: number;
  interrupted_count: number;
  user_id?: string;
  user_email?: string;
  user_display_name?: string;
  user_role?: string;
  platform?: string;
}

/**
 * VTID-01218A: Turn details for session timeline
 */
interface TurnDetail {
  turn_number: number;
  started_at: string;
  ended_at?: string;
  turn_ms?: number;
  first_audio_ms?: number;
  end_turn_source?: 'client' | 'server_vad' | 'timeout' | null;
  was_interrupted: boolean;
  playback_clear_triggered: boolean;
}

/**
 * VTID-01218A: Full session details
 */
interface LiveSessionDetail extends LiveSessionSummary {
  voice?: string;
  input_rate?: number;
  output_rate?: number;
  video_frames?: number;
  origin?: string;
  user_agent?: string;
  modalities?: string[];
  voice_style?: string;
  user_turns?: number;
  model_turns?: number;
  tool_executions?: Array<{ tool_name: string; success: boolean; timestamp: string }>;
  errors: Array<{
    timestamp: string;
    error_code: string;
    error_message: string;
  }>;
}

// Query parameter schemas
const ListSessionsQuerySchema = z.object({
  status: z.enum(['active', 'ended', 'all']).optional().default('all'),
  limit: z.coerce.number().min(1).max(100).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
});

// =============================================================================
// Supabase Client Helper
// =============================================================================

/**
 * VTID-01218A: Get Supabase configuration
 */
function getSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;

  if (!url || !key) {
    console.error('[VTID-01218A] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
    return null;
  }

  return { url, key };
}

/**
 * VTID-01218A: Query OASIS events for voice.live.* events
 */
async function queryVoiceLabEvents(
  filters: {
    eventTypes?: string[];
    sessionId?: string;
    since?: string;
    limit?: number;
    offset?: number;
  }
): Promise<any[]> {
  const config = getSupabaseConfig();
  if (!config) return [];

  try {
    // Build query URL
    let query = `${config.url}/rest/v1/oasis_events?`;
    const params: string[] = [];

    // Filter by event types (topic column)
    if (filters.eventTypes && filters.eventTypes.length > 0) {
      params.push(`topic=in.(${filters.eventTypes.map(t => `"${t}"`).join(',')})`);
    }

    // Filter by session_id in metadata
    if (filters.sessionId) {
      params.push(`metadata->>session_id=eq.${filters.sessionId}`);
    }

    // Time filter
    if (filters.since) {
      params.push(`created_at=gte.${filters.since}`);
    }

    // VTID filter for voice.live events
    params.push(`vtid=eq.VTID-01218A`);

    // Ordering and pagination
    params.push('order=created_at.desc');
    if (filters.limit) params.push(`limit=${filters.limit}`);
    if (filters.offset) params.push(`offset=${filters.offset}`);

    query += params.join('&');
    console.log(`[VTID-01218A] OASIS query: ${query.replace(config.key, '***')}`);

    const resp = await fetch(query, {
      headers: {
        'apikey': config.key,
        'Authorization': `Bearer ${config.key}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`[VTID-01218A] OASIS query failed: ${resp.status} ${resp.statusText} - ${errorText}`);
      return [];
    }

    const results = await resp.json() as any[];
    console.log(`[VTID-01218A] OASIS query returned ${results.length} results`);
    return results;
  } catch (err: any) {
    console.error(`[VTID-01218A] OASIS query error:`, err.message);
    return [];
  }
}

// =============================================================================
// Helpers
// =============================================================================

function parsePlatform(ua: string | null | undefined): string {
  if (!ua) return 'unknown';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mobile/i.test(ua)) return 'Mobile';
  return 'Web';
}

// =============================================================================
// API Endpoints
// =============================================================================

/**
 * GET /api/v1/voice-lab/live/sessions
 *
 * List live sessions with optional status filter.
 *
 * Query params:
 * - status: 'active' | 'ended' | 'all' (default: 'all')
 * - limit: number (default: 50, max: 100)
 * - offset: number (default: 0)
 *
 * Response:
 * {
 *   ok: true,
 *   sessions: LiveSessionSummary[],
 *   total: number
 * }
 */
router.get('/live/sessions', async (req: Request, res: Response) => {
  console.log('[VTID-01218A] GET /voice-lab/live/sessions');

  try {
    // Validate query params
    const query = ListSessionsQuerySchema.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid query parameters',
        details: query.error.errors,
      });
    }

    const { status, limit, offset } = query.data;

    // Query session started events
    console.log('[VTID-01218A] Querying session.started events...');
    const sessionStartEvents = await queryVoiceLabEvents({
      eventTypes: ['voice.live.session.started'],
      limit: limit + 50, // Get more to account for filtering
      offset,
    });
    console.log(`[VTID-01218A] Found ${sessionStartEvents.length} session.started events`);

    // Query session ended events
    const sessionEndEvents = await queryVoiceLabEvents({
      eventTypes: ['voice.live.session.ended'],
      limit: 200, // Get recent ended sessions
    });
    console.log(`[VTID-01218A] Found ${sessionEndEvents.length} session.ended events`);

    // Build session map
    const sessionEndMap = new Map<string, any>();
    for (const event of sessionEndEvents) {
      const sessionId = event.metadata?.session_id;
      if (sessionId && !sessionEndMap.has(sessionId)) {
        sessionEndMap.set(sessionId, event);
      }
    }

    // Build session summaries
    const sessions: LiveSessionSummary[] = [];
    for (const startEvent of sessionStartEvents) {
      const sessionId = startEvent.metadata?.session_id;
      if (!sessionId) continue;

      const endEvent = sessionEndMap.get(sessionId);
      const isActive = !endEvent;

      // Apply status filter
      if (status === 'active' && !isActive) continue;
      if (status === 'ended' && isActive) continue;

      const summary: LiveSessionSummary = {
        session_id: sessionId,
        status: isActive ? 'active' : 'ended',
        started_at: startEvent.created_at,
        ended_at: endEvent?.created_at,
        duration_ms: endEvent?.metadata?.duration_ms,
        turn_count: endEvent?.metadata?.turn_count || endEvent?.metadata?.turn_number || 0,
        audio_in_chunks: endEvent?.metadata?.audio_in_chunks || 0,
        audio_out_chunks: endEvent?.metadata?.audio_out_chunks || 0,
        lang: startEvent.metadata?.lang,
        transport: startEvent.metadata?.transport || 'websocket',
        error_count: 0,
        interrupted_count: endEvent?.metadata?.interrupted_count || 0,
        user_id: startEvent.metadata?.user_id,
        user_email: startEvent.metadata?.email,
        user_display_name: startEvent.metadata?.email?.split('@')[0] || undefined,
        user_role: startEvent.metadata?.active_role,
        platform: parsePlatform(startEvent.metadata?.user_agent),
      };

      sessions.push(summary);

      // Collect limit+1 to detect has_more
      if (sessions.length > limit) break;
    }

    const has_more = sessions.length > limit;
    if (has_more) sessions.pop();

    return res.json({
      ok: true,
      sessions,
      has_more,
      total: sessions.length,
      query: { status, limit, offset },
    });
  } catch (err: any) {
    console.error('[VTID-01218A] Error listing sessions:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'Failed to list sessions',
      details: err.message,
    });
  }
});

/**
 * GET /api/v1/voice-lab/live/sessions/:sessionId
 *
 * Get detailed information about a specific session.
 *
 * Response:
 * {
 *   ok: true,
 *   session: LiveSessionDetail
 * }
 */
router.get('/live/sessions/:sessionId', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  console.log(`[VTID-01218A] GET /voice-lab/live/sessions/${sessionId}`);

  try {
    // Query all events for this session
    const events = await queryVoiceLabEvents({
      sessionId,
      limit: 500,
    });

    if (events.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Session not found',
        session_id: sessionId,
      });
    }

    // Find start and end events
    const startEvent = events.find(e => e.topic === 'voice.live.session.started');
    const endEvent = events.find(e => e.topic === 'voice.live.session.ended');
    const errorEvents = events.filter(e => e.topic === 'voice.live.error');
    const toolEvents = events.filter(e => e.topic?.includes('tool'));

    if (!startEvent) {
      return res.status(404).json({
        ok: false,
        error: 'Session start event not found',
        session_id: sessionId,
      });
    }

    const session: LiveSessionDetail = {
      session_id: sessionId,
      status: endEvent ? 'ended' : 'active',
      started_at: startEvent.created_at,
      ended_at: endEvent?.created_at,
      duration_ms: endEvent?.metadata?.duration_ms,
      turn_count: endEvent?.metadata?.turn_count || endEvent?.metadata?.turn_number || 0,
      audio_in_chunks: endEvent?.metadata?.audio_in_chunks || 0,
      audio_out_chunks: endEvent?.metadata?.audio_out_chunks || 0,
      lang: startEvent.metadata?.lang,
      voice: startEvent.metadata?.voice,
      transport: startEvent.metadata?.transport || 'websocket',
      input_rate: startEvent.metadata?.input_rate,
      output_rate: startEvent.metadata?.output_rate,
      video_frames: endEvent?.metadata?.video_frames,
      user_id: startEvent.metadata?.user_id,
      user_email: startEvent.metadata?.email,
      user_display_name: startEvent.metadata?.email?.split('@')[0] || undefined,
      user_role: startEvent.metadata?.active_role,
      platform: parsePlatform(startEvent.metadata?.user_agent),
      origin: startEvent.metadata?.origin,
      user_agent: startEvent.metadata?.user_agent,
      modalities: startEvent.metadata?.modalities,
      voice_style: startEvent.metadata?.voice,
      user_turns: endEvent?.metadata?.user_turns || 0,
      model_turns: endEvent?.metadata?.model_turns || 0,
      tool_executions: toolEvents.map(e => ({
        tool_name: e.metadata?.tool_name || e.metadata?.function_name || 'unknown',
        success: e.metadata?.success !== false,
        timestamp: e.created_at,
      })),
      error_count: errorEvents.length,
      interrupted_count: endEvent?.metadata?.interrupted_count || 0,
      errors: errorEvents.map(e => ({
        timestamp: e.created_at,
        error_code: e.metadata?.error_code || 'unknown',
        error_message: e.metadata?.error_message || 'Unknown error',
      })),
    };

    return res.json({
      ok: true,
      session,
    });
  } catch (err: any) {
    console.error(`[VTID-01218A] Error getting session ${sessionId}:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'Failed to get session',
      details: err.message,
    });
  }
});

/**
 * GET /api/v1/voice-lab/live/sessions/:sessionId/turns
 *
 * Get turn-by-turn timeline for a session.
 *
 * Response:
 * {
 *   ok: true,
 *   session_id: string,
 *   turns: TurnDetail[]
 * }
 */
router.get('/live/sessions/:sessionId/turns', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  console.log(`[VTID-01218A] GET /voice-lab/live/sessions/${sessionId}/turns`);

  try {
    // Query turn events for this session
    const events = await queryVoiceLabEvents({
      sessionId,
      eventTypes: ['voice.live.turn.started', 'voice.live.turn.completed', 'voice.live.turn.interrupted'],
      limit: 500,
    });

    // Build turn timeline
    const turnStartMap = new Map<number, any>();
    const turnCompleteMap = new Map<number, any>();

    for (const event of events) {
      const turnNumber = event.metadata?.turn_number;
      if (!turnNumber) continue;

      if (event.topic === 'voice.live.turn.started' && !turnStartMap.has(turnNumber)) {
        turnStartMap.set(turnNumber, event);
      } else if (event.topic === 'voice.live.turn.completed' && !turnCompleteMap.has(turnNumber)) {
        turnCompleteMap.set(turnNumber, event);
      }
    }

    // Build turn details
    const turns: TurnDetail[] = [];
    const allTurnNumbers = new Set([...turnStartMap.keys(), ...turnCompleteMap.keys()]);

    for (const turnNumber of Array.from(allTurnNumbers).sort((a, b) => a - b)) {
      const startEvent = turnStartMap.get(turnNumber);
      const completeEvent = turnCompleteMap.get(turnNumber);

      const turn: TurnDetail = {
        turn_number: turnNumber,
        started_at: startEvent?.created_at || completeEvent?.created_at,
        ended_at: completeEvent?.created_at,
        turn_ms: completeEvent?.metadata?.turn_ms,
        first_audio_ms: completeEvent?.metadata?.first_audio_ms,
        end_turn_source: completeEvent?.metadata?.end_turn_source || null,
        was_interrupted: false, // Will be enhanced when interrupt detection is added
        playback_clear_triggered: completeEvent?.metadata?.playback_clear_triggered || false,
      };

      turns.push(turn);
    }

    return res.json({
      ok: true,
      session_id: sessionId,
      turns,
      total: turns.length,
    });
  } catch (err: any) {
    console.error(`[VTID-01218A] Error getting turns for ${sessionId}:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'Failed to get session turns',
      details: err.message,
    });
  }
});

/**
 * GET /api/v1/voice-lab/health
 *
 * Health check for Voice LAB API
 */
router.get('/health', (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    service: 'voice-lab',
    vtid: 'VTID-01218A',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/v1/voice-lab/debug/events
 *
 * Debug endpoint to check if voice.live events exist in OASIS
 */
router.get('/debug/events', async (_req: Request, res: Response) => {
  console.log('[VTID-01218A] GET /voice-lab/debug/events');

  const config = getSupabaseConfig();
  if (!config) {
    return res.status(500).json({
      ok: false,
      error: 'Supabase not configured',
    });
  }

  try {
    // Query ALL events with voice.live topic (no VTID filter)
    const query = `${config.url}/rest/v1/oasis_events?topic=like.voice.live.*&order=created_at.desc&limit=20`;

    const resp = await fetch(query, {
      headers: {
        'apikey': config.key,
        'Authorization': `Bearer ${config.key}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      return res.status(resp.status).json({
        ok: false,
        error: `Query failed: ${resp.status}`,
        details: errorText,
      });
    }

    const events = await resp.json() as any[];

    // Also check for events with VTID-01218A
    const vtidQuery = `${config.url}/rest/v1/oasis_events?vtid=eq.VTID-01218A&order=created_at.desc&limit=20`;
    const vtidResp = await fetch(vtidQuery, {
      headers: {
        'apikey': config.key,
        'Authorization': `Bearer ${config.key}`,
        'Content-Type': 'application/json',
      },
    });

    const vtidEvents = vtidResp.ok ? await vtidResp.json() as any[] : [];

    return res.json({
      ok: true,
      voice_live_events: {
        count: events.length,
        events: events.map((e: any) => ({
          id: e.id,
          topic: e.topic,
          vtid: e.vtid,
          created_at: e.created_at,
          session_id: e.metadata?.session_id,
        })),
      },
      vtid_01218a_events: {
        count: vtidEvents.length,
        events: vtidEvents.map((e: any) => ({
          id: e.id,
          topic: e.topic,
          vtid: e.vtid,
          created_at: e.created_at,
          session_id: e.metadata?.session_id,
        })),
      },
    });
  } catch (err: any) {
    console.error('[VTID-01218A] Debug query error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

export default router;
