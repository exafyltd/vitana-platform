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

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, optionalAuth, type AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { analyzeSessionEvents } from '../services/voice-session-analyzer';
import { runVoiceProbe } from '../services/voice-synthetic-probe';
import {
  releaseQuarantine,
  getQuarantineState,
} from '../services/voice-recurrence-sentinel';
import { spawnInvestigator } from '../services/voice-architecture-investigator';
import { notifyGChat } from '../services/self-healing-snapshot-service';
import { setMode } from '../services/voice-shadow-mode';
import { getVoiceSelfHealingMode } from '../services/voice-self-healing-adapter';
// VTID-02868: per-session quality classification from session-stop metadata.
// Pure function — runs inline on session-list responses without extra I/O.
import { classifyQualityFromSessionStop } from '../services/voice-failure-taxonomy';
import {
  buildHealingSummary,
  buildShadowComparison,
  buildLiveMonitor,
} from '../services/voice-healing-summary';
// VTID-03025: LiveKit hourly tests — Slice 1a foundation.
import {
  runLiveKitTestSuite,
  listRecentRuns as listLivekitTestRuns,
  getRunDetail as getLivekitTestRunDetail,
  listCases as listLivekitTestCases,
} from '../services/voice-lab/livekit-test-runner';
import {
  evaluateLiveKitDryRun,
} from '../services/voice-lab/livekit-test-eval';

const router = Router();

// VTID-VOICE-LAB-HEALTH-PUBLIC: register the health endpoint BEFORE
// `requireAuth` so uptime probes (and the self-healing analyzer's
// synthetic monitor) can hit it without a Bearer token. Without this,
// every probe came back 401, the analyzer misclassified the 401 as
// `import_error`, and a fresh VTID-027xx self-heal failure event was
// logged on every check — ~20 false-positive VTIDs (02756 → 02801)
// accumulated over 2 days before the cause was traced. The duplicate
// registration that used to live near the bottom of this file with a
// `public-route` marker comment was always intended to be public;
// gating it under `requireAuth` was the bug. That now-shadowed
// duplicate has been removed.
router.get('/health', (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    service: 'voice-lab',
    vtid: 'VTID-01218A',
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// VTID-03025: LiveKit hourly tests — Slice 1a foundation.
//
// Routes registered BEFORE `router.use(requireAuth)` because they accept
// EITHER the GitHub Actions cron's service token OR an admin Supabase JWT.
// The same dual gate is used by `routes/oasis-emit.ts`.
//
// POST /tests/run    — execute all enabled cases serially, return summary
// POST /tests/eval   — execute ONE ad-hoc prompt; for debug/admin probing
// GET  /tests/runs   — list recent run summaries
// GET  /tests/runs/:id — full results for one run
// GET  /tests/cases  — list registered cases
// =============================================================================

const LIVEKIT_TESTS_VTID = 'VTID-03025';

function livekitTestsAuthGate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.header('authorization') ?? req.header('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({
      ok: false,
      error: 'missing bearer token',
      vtid: LIVEKIT_TESTS_VTID,
    });
    return;
  }
  const token = header.slice('bearer '.length).trim();
  if (!token) {
    res.status(401).json({
      ok: false,
      error: 'empty bearer token',
      vtid: LIVEKIT_TESTS_VTID,
    });
    return;
  }

  // Path 1: app-level service-token compare — cheapest path, used by Cloud
  // Shell + by future hourly cron when the GH-Actions secret is in sync.
  const serviceToken = process.env.GATEWAY_SERVICE_TOKEN ?? '';
  if (serviceToken.length > 0 && token === serviceToken) {
    (req as AuthenticatedRequest).identity = undefined;
    (req as Request & { __livekit_tests_actor?: string }).__livekit_tests_actor =
      'service:cron';
    next();
    return;
  }

  // Path 2: Google id_token from a GCP service account (Workload Identity
  // Federation, Cloud Scheduler with OIDC, etc.). Robust to the GH-secret /
  // Secret-Manager value drifting out of sync because the caller mints a
  // fresh id_token each call. Audience must match this gateway's URL.
  // Email is required to end in .iam.gserviceaccount.com so user OAuth
  // tokens can never satisfy this path.
  void (async (): Promise<void> => {
    try {
      const { OAuth2Client } = await import('google-auth-library');
      const audience =
        process.env.LIVEKIT_TESTS_GCP_AUDIENCE ??
        process.env.GATEWAY_SELF_URL ??
        'https://gateway-86804897789.us-central1.run.app';
      const client = new OAuth2Client();
      const ticket = await client.verifyIdToken({ idToken: token, audience });
      const payload = ticket.getPayload();
      if (
        payload?.email &&
        payload.email_verified === true &&
        /\.iam\.gserviceaccount\.com$/i.test(payload.email)
      ) {
        (req as AuthenticatedRequest).identity = undefined;
        (req as Request & { __livekit_tests_actor?: string }).__livekit_tests_actor =
          `gcp_sa:${payload.email}`;
        next();
        return;
      }
    } catch {
      // Not a valid Google id_token / audience mismatch — fall through to JWT.
    }

    // Path 3: exafy_admin Supabase JWT (Command Hub operators).
    optionalAuth(req as AuthenticatedRequest, res, () => {
      const id = (req as AuthenticatedRequest).identity;
      if (id && id.exafy_admin === true) {
        (req as Request & { __livekit_tests_actor?: string }).__livekit_tests_actor =
          `admin:${id.user_id ?? 'unknown'}`;
        next();
        return;
      }
      res.status(401).json({
        ok: false,
        error: 'unauthorized — service token, GCP SA id_token, or exafy_admin JWT required',
        vtid: LIVEKIT_TESTS_VTID,
      });
    });
  })();
}

const RunPostSchema = z.object({
  trigger: z.enum(['manual', 'cron', 'admin', 'test']).default('manual'),
  case_key: z.string().min(1).max(128).optional(),
  layer: z.enum(['A', 'B']).default('A'),
});

router.post(
  '/tests/run',
  livekitTestsAuthGate,
  async (req: Request, res: Response) => {
    const parsed = RunPostSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'invalid request body',
        issues: parsed.error.issues,
        vtid: LIVEKIT_TESTS_VTID,
      });
    }
    try {
      const summary = await runLiveKitTestSuite({
        trigger: parsed.data.trigger,
        caseKey: parsed.data.case_key,
        layer: parsed.data.layer,
      });
      return res.status(200).json({ ok: true, vtid: LIVEKIT_TESTS_VTID, summary });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: (err as Error).message ?? String(err),
        vtid: LIVEKIT_TESTS_VTID,
      });
    }
  },
);

const EvalPostSchema = z.object({
  prompt: z.string().min(1).max(4000),
  language: z.string().min(2).max(8).optional(),
  current_route: z.string().max(256).nullable().optional(),
  active_role: z.string().max(64).optional(),
});

router.post(
  '/tests/eval',
  livekitTestsAuthGate,
  async (req: Request, res: Response) => {
    const parsed = EvalPostSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'invalid request body',
        issues: parsed.error.issues,
        vtid: LIVEKIT_TESTS_VTID,
      });
    }
    try {
      const result = await evaluateLiveKitDryRun({
        prompt: parsed.data.prompt,
        language: parsed.data.language,
        currentRoute: parsed.data.current_route,
        activeRole: parsed.data.active_role,
      });
      return res.status(200).json({ ok: true, vtid: LIVEKIT_TESTS_VTID, result });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: (err as Error).message ?? String(err),
        vtid: LIVEKIT_TESTS_VTID,
      });
    }
  },
);

router.get(
  '/tests/runs',
  livekitTestsAuthGate,
  async (req: Request, res: Response) => {
    const limitRaw = req.query.limit;
    const limit = typeof limitRaw === 'string' ? Number(limitRaw) : 50;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    try {
      const runs = await listLivekitTestRuns(safeLimit);
      return res.status(200).json({ ok: true, vtid: LIVEKIT_TESTS_VTID, runs });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: (err as Error).message ?? String(err),
        vtid: LIVEKIT_TESTS_VTID,
      });
    }
  },
);

router.get(
  '/tests/runs/:id',
  livekitTestsAuthGate,
  async (req: Request, res: Response) => {
    try {
      const detail = await getLivekitTestRunDetail(req.params.id);
      if (!detail) {
        return res.status(404).json({
          ok: false,
          error: 'run not found',
          vtid: LIVEKIT_TESTS_VTID,
        });
      }
      return res.status(200).json({ ok: true, vtid: LIVEKIT_TESTS_VTID, ...detail });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: (err as Error).message ?? String(err),
        vtid: LIVEKIT_TESTS_VTID,
      });
    }
  },
);

router.get(
  '/tests/cases',
  livekitTestsAuthGate,
  async (_req: Request, res: Response) => {
    try {
      const cases = await listLivekitTestCases();
      return res.status(200).json({ ok: true, vtid: LIVEKIT_TESTS_VTID, cases });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: (err as Error).message ?? String(err),
        vtid: LIVEKIT_TESTS_VTID,
      });
    }
  },
);

router.use(requireAuth);

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
  // VTID-02986: 'livekit' added so orb-agent sessions can ship through the
  // same shape. Vertex still emits 'websocket' or 'sse'; the UI badges by
  // value so 'livekit' is distinguishable from those.
  transport: 'websocket' | 'sse' | 'livekit';
  error_count: number;
  interrupted_count: number;
  user_id?: string;
  // VTID-01969: speakable Vitana ID for support readability. Resolved from
  // app_users at session-summary time via cached lookup. Null-tolerant:
  // undefined for legacy sessions before Release A backfill.
  vitana_id?: string | null;
  user_email?: string;
  user_display_name?: string;
  user_role?: string;
  platform?: string;
  // VTID-02868: quality classification from session-stop metadata
  // (voice-failure-taxonomy.ts canonical taxonomy). Null when the session
  // is active OR when metrics don't match any quality class — that's the
  // healthy / pre-completion default. Surfaced in the Voice Lab list +
  // drawer so operators can scan for failure patterns without leaving
  // the screen.
  failure_class?: string | null;
  failure_signature?: string | null;
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

    // VTID filter: VTID-01218A (legacy voice-lab) + VTID-01155 (orb-live emitter)
    // + VTID-VOICE-HEALING (autonomous self-healing loop events: dispatched,
    // verdict, rollback, suppressed, spec_memory.blocked, investigation.completed)
    // + VTID-LIVEKIT-AGENT (VTID-02986: orb-agent emits vtid.live.session.start/stop
    //   with this VTID; required for LiveKit sessions to appear next to Vertex
    //   in the unified Voice Lab list).
    params.push(`vtid=in.("VTID-01218A","VTID-01155","VTID-VOICE-HEALING","VTID-LIVEKIT-AGENT")`);

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

    // Query session started events (both legacy voice.live.* and current vtid.live.* topics)
    console.log('[VTID-01218A] Querying session start events...');
    const sessionStartEvents = await queryVoiceLabEvents({
      eventTypes: ['voice.live.session.started', 'vtid.live.session.start'],
      limit: limit + 50, // Get more to account for filtering
      offset,
    });
    console.log(`[VTID-01218A] Found ${sessionStartEvents.length} session start events`);

    // Query session ended events
    const sessionEndEvents = await queryVoiceLabEvents({
      eventTypes: ['voice.live.session.ended', 'vtid.live.session.stop'],
      limit: 200, // Get recent ended sessions
    });
    console.log(`[VTID-01218A] Found ${sessionEndEvents.length} session end events`);

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

      // Calculate duration from metadata or from timestamps
      const summaryDurationMs = endEvent?.metadata?.duration_ms
        || (endEvent?.created_at && startEvent.created_at
          ? new Date(endEvent.created_at).getTime() - new Date(startEvent.created_at).getTime()
          : undefined);

      // VTID-02868: classify quality from session-stop metadata (only when
      // ended; active sessions haven't produced the metrics yet). Pure
      // function from voice-failure-taxonomy — no I/O.
      let failureClass: string | null = null;
      let failureSignature: string | null = null;
      if (endEvent && endEvent.metadata) {
        const classified = classifyQualityFromSessionStop({
          audio_in_chunks: Number(endEvent.metadata.audio_in_chunks ?? 0),
          audio_out_chunks: Number(endEvent.metadata.audio_out_chunks ?? 0),
          duration_ms: Number(endEvent.metadata.duration_ms ?? 0),
          turn_count: Number(endEvent.metadata.turn_count ?? endEvent.metadata.turn_number ?? 0),
        });
        if (classified) {
          failureClass = classified.class;
          failureSignature = classified.normalized_signature;
        }
      }

      const summary: LiveSessionSummary = {
        session_id: sessionId,
        status: isActive ? 'active' : 'ended',
        started_at: startEvent.created_at,
        ended_at: endEvent?.created_at,
        duration_ms: summaryDurationMs,
        turn_count: endEvent?.metadata?.turn_count || endEvent?.metadata?.turn_number || 0,
        audio_in_chunks: endEvent?.metadata?.audio_in_chunks || 0,
        audio_out_chunks: endEvent?.metadata?.audio_out_chunks || 0,
        lang: startEvent.metadata?.lang,
        transport: startEvent.metadata?.transport || 'websocket',
        error_count: 0,
        interrupted_count: endEvent?.metadata?.interrupted_count || 0,
        user_id: startEvent.metadata?.user_id,
        // VTID-01969: prefer vitana_id from the OASIS event (Release B
        // backfill on oasis_events.vitana_id), fall back to metadata if
        // present. Null-tolerant — Voice Lab UI shows UUID alone if missing.
        vitana_id: (startEvent as any).vitana_id || startEvent.metadata?.vitana_id || null,
        user_email: startEvent.metadata?.email,
        user_display_name: startEvent.metadata?.email?.split('@')[0] || undefined,
        user_role: startEvent.metadata?.active_role,
        platform: parsePlatform(startEvent.metadata?.user_agent),
        failure_class: failureClass,
        failure_signature: failureSignature,
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

    // Find start and end events (match both legacy voice.live.* and current vtid.live.* topics)
    const startEvent = events.find(e => e.topic === 'voice.live.session.started' || e.topic === 'vtid.live.session.start');
    const endEvent = events.find(e => e.topic === 'voice.live.session.ended' || e.topic === 'vtid.live.session.stop');
    const errorEvents = events.filter(e => e.topic === 'voice.live.error' || e.topic?.includes('error'));
    const toolEvents = events.filter(e => e.topic?.includes('tool'));

    if (!startEvent) {
      return res.status(404).json({
        ok: false,
        error: 'Session start event not found',
        session_id: sessionId,
      });
    }

    // Calculate duration from metadata or from timestamps
    const durationMs = endEvent?.metadata?.duration_ms
      || (endEvent?.created_at && startEvent.created_at
        ? new Date(endEvent.created_at).getTime() - new Date(startEvent.created_at).getTime()
        : undefined);

    const session: LiveSessionDetail = {
      session_id: sessionId,
      status: endEvent ? 'ended' : 'active',
      started_at: startEvent.created_at,
      ended_at: endEvent?.created_at,
      duration_ms: durationMs,
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
      // VTID-01969: speakable Vitana ID (see LiveSessionSummary comment).
      vitana_id: (startEvent as any).vitana_id || startEvent.metadata?.vitana_id || null,
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
      eventTypes: ['voice.live.turn.started', 'voice.live.turn.completed', 'voice.live.turn.interrupted',
                   'vtid.live.turn.started', 'vtid.live.turn.completed', 'vtid.live.turn.interrupted'],
      limit: 500,
    });

    // Build turn timeline
    const turnStartMap = new Map<number, any>();
    const turnCompleteMap = new Map<number, any>();

    for (const event of events) {
      const turnNumber = event.metadata?.turn_number;
      if (!turnNumber) continue;

      if ((event.topic === 'voice.live.turn.started' || event.topic === 'vtid.live.turn.started') && !turnStartMap.has(turnNumber)) {
        turnStartMap.set(turnNumber, event);
      } else if ((event.topic === 'voice.live.turn.completed' || event.topic === 'vtid.live.turn.completed') && !turnCompleteMap.has(turnNumber)) {
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
 * GET /api/v1/voice-lab/live/sessions/:sessionId/diagnostics
 *
 * Get pipeline diagnostic events for a session.
 * These are emitted by emitDiag() at critical pipeline points in orb-live.ts.
 *
 * Response:
 * {
 *   ok: true,
 *   session_id: string,
 *   diagnostics: DiagEvent[],
 *   analysis: { stall_detected, missing_stages, last_stage, ... }
 * }
 */
router.get('/live/sessions/:sessionId/diagnostics', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  console.log(`[VTID-01218A] GET /voice-lab/live/sessions/${sessionId}/diagnostics`);

  try {
    const config = getSupabaseConfig();
    if (!config) {
      return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    }

    // Logic extracted to services/voice-session-analyzer.ts (VTID-01958) so the
    // same flow analysis can run server-side outside the HTTP route — used by
    // the Voice Session Classifier in autonomous self-healing.
    const result = await analyzeSessionEvents(sessionId);
    console.log(
      `[VTID-01218A] Analyzed ${result.diagnostics.length} diagnostic events for session ${sessionId}`,
    );

    return res.json({
      ok: true,
      session_id: sessionId,
      diagnostics: result.diagnostics,
      analysis: result.analysis,
    });
  } catch (err: any) {
    console.error(`[VTID-01218A] Error getting diagnostics for ${sessionId}:`, err.message);
    return res.status(500).json({ ok: false, error: 'Failed to get diagnostics', details: err.message });
  }
});

/**
 * POST /api/v1/voice-lab/probe (VTID-01961, PR #4)
 *
 * Manual trigger for the Synthetic Voice Probe. Returns the structured
 * probe verdict (ok, failure_mode_code, duration_ms, evidence). Used by
 * ops to spot-check the voice path without waiting for the next session,
 * and by the reconciler verification branch on voice synthetic-endpoint
 * rows.
 */
router.post('/probe', async (_req: Request, res: Response) => {
  console.log('[VTID-01961] POST /voice-lab/probe — running synthetic voice probe');
  try {
    const result = await runVoiceProbe();
    return res.json(result);
  } catch (err: any) {
    console.error('[VTID-01961] Probe error:', err.message);
    return res
      .status(500)
      .json({ ok: false, error: 'Probe internal error', details: err.message });
  }
});

/**
 * GET /api/v1/voice-lab/healing/quarantine?class=...&signature=... (VTID-01962, PR #5)
 *
 * Inspect the current quarantine state for a (class, signature) pair.
 * Returns 404 if no row exists (= active by default).
 */
router.get('/healing/quarantine', async (req: Request, res: Response) => {
  const klass = String(req.query.class || '');
  const signature = String(req.query.signature || '');
  if (!klass || !signature) {
    return res.status(400).json({ ok: false, error: 'class and signature query params required' });
  }
  const row = await getQuarantineState(klass, signature);
  if (!row) {
    return res.status(404).json({ ok: false, error: 'no quarantine row (= active)' });
  }
  return res.json({ ok: true, ...row });
});

/**
 * POST /api/v1/voice-lab/healing/quarantine/release (VTID-01962, PR #5)
 *
 * Move a quarantined (class, signature) into 72h probation. Halved
 * thresholds + max 1 dispatch per day apply during probation. The
 * probation expires automatically without re-quarantine, transitioning
 * to 'released'.
 *
 * Body: { class: string, signature: string, reason?: string }
 */
router.post('/healing/quarantine/release', async (req: Request, res: Response) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const klass = typeof body.class === 'string' ? body.class : '';
  const signature = typeof body.signature === 'string' ? body.signature : '';
  const reason = typeof body.reason === 'string' ? body.reason : undefined;
  if (!klass || !signature) {
    return res.status(400).json({ ok: false, error: 'class and signature body fields required' });
  }
  const r = await releaseQuarantine(klass, signature, reason);
  if (!r.ok) {
    return res.status(400).json({
      ok: false,
      error: r.error || 'release_failed',
      new_status: r.new_status,
      probation_until: r.probation_until,
    });
  }
  return res.json({
    ok: true,
    new_status: r.new_status,
    probation_until: r.probation_until,
  });
});

/**
 * POST /api/v1/voice-lab/healing/investigate (VTID-01963, PR #6)
 *
 * Manual trigger for the Architecture Investigator. Used by ops to
 * spot-spawn an investigation outside the Sentinel/Spec Memory Gate
 * automatic paths, e.g., to validate prompt iteration without waiting
 * for a real quarantine event.
 *
 * Body: { class: string, signature?: string, notes?: string, related_vtid?: string }
 */
router.post('/healing/investigate', async (req: Request, res: Response) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const klass = typeof body.class === 'string' ? body.class : '';
  const signature = typeof body.signature === 'string' ? body.signature : null;
  const notes = typeof body.notes === 'string' ? body.notes : undefined;
  const related_vtid =
    typeof body.related_vtid === 'string' ? body.related_vtid : undefined;
  if (!klass) {
    return res.status(400).json({ ok: false, error: 'class body field required' });
  }
  const r = await spawnInvestigator({
    class: klass,
    normalized_signature: signature,
    trigger_reason: 'manual',
    related_vtid: related_vtid ?? null,
    notes,
  });
  return res.json(r);
});

/**
 * GET /api/v1/voice-lab/healing/reports?class=&limit= (VTID-01963, PR #6)
 *
 * List Architecture Investigator reports, optionally filtered by class.
 * Used by the Healing dashboard (PR #8). Returns most-recent-first.
 */
router.get('/healing/reports', async (req: Request, res: Response) => {
  const config = getSupabaseConfig();
  if (!config) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  const klass = typeof req.query.class === 'string' ? req.query.class : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const filter = klass ? `class=eq.${encodeURIComponent(klass)}&` : '';
  const url =
    `${config.url}/rest/v1/voice_architecture_reports?` +
    `${filter}order=generated_at.desc&limit=${limit}`;
  try {
    const resp = await fetch(url, {
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
    });
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ ok: false, error: text });
    }
    const rows = await resp.json();
    return res.json({ ok: true, reports: rows });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/v1/voice-lab/healing/reports/:id (VTID-01963, PR #6)
 *
 * Fetch a single Architecture Investigator report.
 */
router.get('/healing/reports/:id', async (req: Request, res: Response) => {
  const config = getSupabaseConfig();
  if (!config) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  const id = req.params.id;
  const url = `${config.url}/rest/v1/voice_architecture_reports?id=eq.${encodeURIComponent(id)}&limit=1`;
  try {
    const resp = await fetch(url, {
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
    });
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ ok: false, error: text });
    }
    const rows = (await resp.json()) as any[];
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'report not found' });
    }
    return res.json({ ok: true, report: rows[0] });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PATCH /api/v1/voice-lab/healing/reports/:id (VTID-01999)
 *
 * Update a report's decision state. Used by the inline drawer in the
 * Voice Self-Healing panel — operator reads the report, decides
 * acknowledged / accepted / rejected, and submits decision_notes.
 *
 * Body: { status: 'acknowledged'|'accepted'|'rejected', decision_notes?: string, acknowledged_by?: string }
 */
router.patch('/healing/reports/:id', async (req: Request, res: Response) => {
  const config = getSupabaseConfig();
  if (!config) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  const body = (req.body || {}) as Record<string, unknown>;
  const status = body.status;
  if (status !== 'acknowledged' && status !== 'accepted' && status !== 'rejected' && status !== 'open') {
    return res.status(400).json({
      ok: false,
      error: 'status must be one of open|acknowledged|accepted|rejected',
    });
  }
  const decision_notes = typeof body.decision_notes === 'string' ? body.decision_notes : null;
  const acknowledged_by = typeof body.acknowledged_by === 'string' ? body.acknowledged_by : 'command-hub';

  const id = req.params.id;
  const patch: Record<string, unknown> = {
    status,
    decision_notes,
  };
  // Only stamp acknowledged_at/by when transitioning AWAY from 'open'.
  if (status !== 'open') {
    patch.acknowledged_by = acknowledged_by;
    patch.acknowledged_at = new Date().toISOString();
  } else {
    patch.acknowledged_by = null;
    patch.acknowledged_at = null;
  }
  try {
    const resp = await fetch(
      `${config.url}/rest/v1/voice_architecture_reports?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: config.key,
          Authorization: `Bearer ${config.key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(patch),
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ ok: false, error: text });
    }
    const rows = (await resp.json()) as any[];
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'report not found' });
    }
    return res.json({ ok: true, report: rows[0] });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/v1/voice-lab/healing/reports/:id/execute (VTID-02021)
 *
 * Materialize the report's recommendation into actual work items. For each
 * proposed_next_step, allocates a VTID via the canonical RPC, populates the
 * vtid_ledger row (status=scheduled, spec_status=approved, layer=INFRA,
 * module=GATEWAY) with the step text as title/summary, and stamps
 * metadata.source_report_id so we can join back later.
 *
 * The caller's intent: "I read the plan, I approve it, execute it." Sets
 * voice_architecture_reports.status = accepted and emits a
 * voice.healing.report.executed OASIS event.
 *
 * Body: { acknowledged_by?: string, decision_notes?: string }
 *
 * Returns: { ok, executed_vtids, report_id, step_count }
 */
router.post('/healing/reports/:id/execute', async (req: Request, res: Response) => {
  const config = getSupabaseConfig();
  if (!config) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  const reportId = req.params.id;
  const body = (req.body || {}) as Record<string, unknown>;
  const acknowledgedBy =
    typeof body.acknowledged_by === 'string' ? body.acknowledged_by : 'command-hub';
  const decisionNotes =
    typeof body.decision_notes === 'string' ? body.decision_notes : null;

  // 1. Fetch report
  let report: any = null;
  try {
    const r = await fetch(
      `${config.url}/rest/v1/voice_architecture_reports?id=eq.${encodeURIComponent(reportId)}&limit=1`,
      { headers: { apikey: config.key, Authorization: `Bearer ${config.key}` } },
    );
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: await r.text() });
    }
    const rows = (await r.json()) as any[];
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'report not found' });
    report = rows[0];
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }

  // VTID-02032: idempotency. Once a report has been accepted (or rejected),
  // a second click on Accept & Execute must NOT create a duplicate batch.
  // Return 409 with a clear message + a hint to the /execution endpoint
  // so the frontend can route the operator to the existing in-progress
  // tasks instead.
  if (report.status && report.status !== 'open') {
    return res.status(409).json({
      ok: false,
      error: `report already ${report.status}`,
      status: report.status,
      acknowledged_by: report.acknowledged_by ?? null,
      acknowledged_at: report.acknowledged_at ?? null,
      execution_endpoint: `/api/v1/voice-lab/healing/reports/${reportId}/execution`,
    });
  }

  // 2. Extract proposed steps
  const steps = (report.report?.recommendation?.proposed_next_steps || []) as string[];
  if (!Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'report has no recommendation.proposed_next_steps to execute',
    });
  }

  const reportClass = String(report.class || 'voice.unknown');
  const reportSig = report.normalized_signature ?? null;

  // 3. For each step: allocate VTID + populate ledger row
  const executedVtids: string[] = [];
  const failures: Array<{ step: string; error: string }> = [];
  for (let i = 0; i < steps.length; i++) {
    const step = String(steps[i] || '').trim();
    if (!step) continue;
    try {
      // 3a. Allocate VTID via RPC
      const allocResp = await fetch(`${config.url}/rest/v1/rpc/allocate_global_vtid`, {
        method: 'POST',
        headers: {
          apikey: config.key,
          Authorization: `Bearer ${config.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_source: 'voice-investigator-execute',
          p_layer: 'INFRA',
          p_module: 'GATEWAY',
        }),
      });
      if (!allocResp.ok) {
        failures.push({ step: step.slice(0, 80), error: `alloc_${allocResp.status}` });
        continue;
      }
      const allocRows = (await allocResp.json()) as Array<{ vtid: string }>;
      const newVtid = allocRows[0]?.vtid;
      if (!newVtid) {
        failures.push({ step: step.slice(0, 80), error: 'alloc_no_vtid_returned' });
        continue;
      }

      // 3b. Populate the ledger row (the RPC creates an allocated stub)
      const title = `INVESTIGATOR: ${step.slice(0, 180)}`;
      const summary =
        `${step}\n\n---\n` +
        `Source: voice-architecture-investigator report ${reportId}\n` +
        `Class: ${reportClass}\n` +
        `Signature: ${reportSig ?? '(none)'}\n` +
        `Step ${i + 1} of ${steps.length}`;
      const patchResp = await fetch(
        `${config.url}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(newVtid)}`,
        {
          method: 'PATCH',
          headers: {
            apikey: config.key,
            Authorization: `Bearer ${config.key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            title,
            summary,
            layer: 'INFRA',
            module: 'GATEWAY',
            status: 'scheduled',
            spec_status: 'approved',
            assigned_to: 'autopilot',
            metadata: {
              source: 'voice-investigator-execute',
              source_report_id: reportId,
              source_report_class: reportClass,
              source_report_signature: reportSig,
              step_index: i,
              step_total: steps.length,
            },
            updated_at: new Date().toISOString(),
          }),
        },
      );
      if (!patchResp.ok) {
        failures.push({ step: step.slice(0, 80), error: `patch_${patchResp.status}` });
        continue;
      }
      executedVtids.push(newVtid);

      // VTID-02029: cross-cutting visibility. Insert into self_healing_log
      // and emit self-healing.task.injected so this VTID appears in the
      // existing Self-Healing History list and Autonomy Trace timeline
      // alongside dev-autopilot self-heals — operator doesn't have to
      // know about a separate voice silo.
      const recommendation = report.report?.recommendation || {};
      const recConfidence =
        typeof recommendation.confidence === 'number' ? recommendation.confidence : 0.5;
      const shlogEndpoint = `voice-error://${reportClass}`;
      fetch(`${config.url}/rest/v1/self_healing_log`, {
        method: 'POST',
        headers: {
          apikey: config.key,
          Authorization: `Bearer ${config.key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          vtid: newVtid,
          endpoint: shlogEndpoint,
          failure_class: reportClass,
          confidence: recConfidence,
          diagnosis: {
            source: 'voice-investigator-execute',
            source_report_id: reportId,
            normalized_signature: reportSig,
            recommendation_track: recommendation.track || null,
            step_index: i,
            step_total: steps.length,
            step_text: step.slice(0, 500),
            },
          outcome: 'pending',
          blast_radius: 'none',
          attempt_number: 1,
        }),
      }).catch(() => { /* best-effort */ });

      // Emit self-healing.task.injected so Autonomy Trace + downstream
      // listeners see the same event the canonical injector emits.
      try {
        const { emitOasisEvent } = await import('../services/oasis-event-service');
        await emitOasisEvent({
          vtid: newVtid,
          type: 'self-healing.task.injected',
          source: 'voice-investigator-execute',
          status: 'info',
          message: `Voice investigator step ${i + 1}/${steps.length} injected: ${title.slice(0, 100)}`,
          payload: {
            service: 'orb-voice',
            endpoint: shlogEndpoint,
            failure_class: reportClass,
            confidence: recConfidence,
            source_report_id: reportId,
            normalized_signature: reportSig,
            step_index: i,
            step_total: steps.length,
            recommendation_track: recommendation.track || null,
            auto_approved: true,
          },
        });
      } catch { /* best-effort */ }
    } catch (err: any) {
      failures.push({ step: step.slice(0, 80), error: err?.message ?? 'unknown' });
    }
  }

  // 4. Update the report row to accepted
  try {
    await fetch(
      `${config.url}/rest/v1/voice_architecture_reports?id=eq.${encodeURIComponent(reportId)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: config.key,
          Authorization: `Bearer ${config.key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          status: 'accepted',
          acknowledged_by: acknowledgedBy,
          acknowledged_at: new Date().toISOString(),
          decision_notes: decisionNotes,
        }),
      },
    );
  } catch {
    /* best-effort — VTIDs are already created so the user has visible work */
  }

  // 5. Emit OASIS event for audit
  try {
    const { emitOasisEvent } = await import('../services/oasis-event-service');
    await emitOasisEvent({
      vtid: 'VTID-VOICE-HEALING',
      type: 'voice.healing.investigation.completed',
      source: 'voice-lab',
      status: 'success',
      message: `Investigator report accepted and executed (${executedVtids.length} VTIDs scheduled${failures.length ? `, ${failures.length} failed` : ''})`,
      payload: {
        report_id: reportId,
        class: reportClass,
        normalized_signature: reportSig,
        executed_vtids: executedVtids,
        failures,
        acknowledged_by: acknowledgedBy,
      },
    });
  } catch {
    /* best-effort */
  }

  return res.json({
    ok: true,
    report_id: reportId,
    step_count: steps.length,
    executed_vtids: executedVtids,
    failures: failures.length > 0 ? failures : undefined,
  });
});

/**
 * GET /api/v1/voice-lab/healing/reports/:id/execution (VTID-02021)
 *
 * Returns the live status of every VTID created from this report's
 * Accept-and-Execute action. Drives the drawer's "Execution Progress"
 * polling — operator sees scheduled → in_progress → completed/failed
 * without leaving the Self-Healing screen.
 */
router.get('/healing/reports/:id/execution', async (req: Request, res: Response) => {
  const config = getSupabaseConfig();
  if (!config) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  const reportId = req.params.id;
  // PostgREST: filter on JSONB key value via metadata->>source_report_id=eq.<id>
  const url =
    `${config.url}/rest/v1/vtid_ledger?` +
    `metadata->>source_report_id=eq.${encodeURIComponent(reportId)}&` +
    `select=vtid,title,status,spec_status,is_terminal,terminal_outcome,claimed_by,updated_at,metadata&` +
    `order=metadata->step_index.asc.nullslast,vtid.asc&limit=50`;
  try {
    const resp = await fetch(url, {
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
    });
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ ok: false, error: text });
    }
    const rows = (await resp.json()) as any[];
    return res.json({ ok: true, report_id: reportId, vtids: rows });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/v1/voice-lab/healing/mode (VTID-01964, PR #7)
 *
 * Returns the current voice self-healing mode (off / shadow / live).
 * Forces a fresh read past the 30s in-memory cache.
 */
router.get('/healing/mode', async (_req: Request, res: Response) => {
  const mode = await getVoiceSelfHealingMode(true);
  return res.json({ ok: true, mode });
});

/**
 * POST /api/v1/voice-lab/healing/gchat-ping-test (VTID-02030c)
 *
 * Diagnostic only. Sends a single test message via the same notifyGChat()
 * helper used by quarantine + investigator pings. Reports whether the
 * env var is set and whether the fetch actually fired. No side effects
 * other than the message itself.
 */
router.post('/healing/gchat-ping-test', async (req: Request, res: Response) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const note = typeof body.note === 'string' ? body.note : 'manual diagnostic';
  const webhook = process.env.GCHAT_COMMANDHUB_WEBHOOK || '';
  const text =
    `🔧 *Gchat ping diagnostic* (VTID-02030f)\n` +
    `If you see this, the gateway → Gchat path works.\n` +
    `Note: ${note}\n` +
    `Time: ${new Date().toISOString()}`;
  const result = await notifyGChat(text);
  // Capture useful diagnostics about the webhook URL itself without leaking
  // its full value: domain, path prefix, query-keys present.
  let url_host: string | null = null;
  let url_path_prefix: string | null = null;
  let query_keys: string[] = [];
  if (webhook) {
    try {
      const u = new URL(webhook);
      url_host = u.host;
      url_path_prefix = u.pathname.split('/').slice(0, 4).join('/');
      query_keys = Array.from(u.searchParams.keys()).sort();
    } catch { /* malformed url */ }
  }
  return res.json({
    ...result,
    webhook_url_host: url_host,
    webhook_url_path_prefix: url_path_prefix,
    webhook_query_keys: query_keys,
  });
});

/**
 * POST /api/v1/voice-lab/healing/mode (VTID-01964, PR #7)
 *
 * Flip system_config.voice_self_healing_mode. Body: { mode: 'off' | 'shadow' | 'live', vtid?: string }.
 * Idempotent. Emits voice.healing.dispatched (mode flip event) for audit.
 */
router.post('/healing/mode', async (req: Request, res: Response) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const next = body.mode;
  const actorVtid = typeof body.vtid === 'string' ? body.vtid : 'VTID-VOICE-HEALING';
  if (next !== 'off' && next !== 'shadow' && next !== 'live') {
    return res.status(400).json({ ok: false, error: 'mode must be one of off|shadow|live' });
  }
  const r = await setMode(next, actorVtid);
  return res.json(r);
});

/**
 * GET /api/v1/voice-lab/healing/summary (VTID-01965, PR #8)
 *
 * Aggregated dashboard view: per-class 24h/7d/30d dispatch counts,
 * fix success rate (probe-verified), avg time-to-recurrence, rollback
 * count, quarantine status, probation status, latest investigation
 * report ID, and unknown-class debt percentage with the SLO band.
 *
 * Read-only and side-effect-free; safe to poll from the dashboard.
 */
router.get('/healing/summary', async (_req: Request, res: Response) => {
  try {
    const s = await buildHealingSummary();
    return res.json({ ok: true, ...s });
  } catch (err: any) {
    console.error('[VTID-01965] /healing/summary error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/v1/voice-lab/healing/shadow-comparison?window_hours=48 (VTID-01965, PR #8)
 *
 * Joins voice_healing_shadow_log decisions in the window with the
 * actual outcomes captured in voice_healing_history for the same
 * (class, normalized_signature) pair (±15 min match window).
 *
 * Used during the ≥48h shadow observation period before flipping
 * mode=live. The match_rate field is the headline number ops watches.
 */
router.get('/healing/shadow-comparison', async (req: Request, res: Response) => {
  const window_hours = Math.min(
    Math.max(Number(req.query.window_hours) || 48, 1),
    24 * 30,
  );
  try {
    const c = await buildShadowComparison(window_hours);
    return res.json({ ok: true, ...c });
  } catch (err: any) {
    console.error('[VTID-01965] /healing/shadow-comparison error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/v1/voice-lab/healing/live-monitor (VTID-01991)
 *
 * Real-time view for the Command Hub Voice tab. Recent voice session-stops
 * with audio_in/audio_out ratios + 24h health rollup + watchdog telemetry
 * (watchdog_skipped vs watchdog_fired) so ops can see the VTID-01984
 * watchdog fix working.
 */
router.get('/healing/live-monitor', async (_req: Request, res: Response) => {
  try {
    const m = await buildLiveMonitor();
    return res.json({ ok: true, ...m });
  } catch (err: any) {
    console.error('[VTID-01991] /healing/live-monitor error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// `/health` is registered above `router.use(requireAuth)` near the top of
// this file (VTID-VOICE-LAB-HEALTH-PUBLIC) so uptime monitors hit it
// without auth. The duplicate registration that used to live here was
// shadowed by the earlier one and is removed.

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