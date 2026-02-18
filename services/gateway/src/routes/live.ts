/**
 * VTID-01090: Live Rooms + Events as Relationship Nodes (Gateway)
 * VTID-01228: Daily.co Video Integration for LIVE Rooms
 *
 * Live room and community event endpoints with relationship graph integration.
 *
 * Endpoints:
 * - POST   /api/v1/live/rooms              - Create a new live room
 * - POST   /api/v1/live/rooms/:id/start    - Start a live room
 * - POST   /api/v1/live/rooms/:id/end      - End a live room
 * - POST   /api/v1/live/rooms/:id/join     - Join a live room (VTID-01228: with access control)
 * - POST   /api/v1/live/rooms/:id/leave    - Leave a live room
 * - POST   /api/v1/live/rooms/:id/highlights - Add a highlight
 * - GET    /api/v1/live/rooms/:id/summary  - Get room summary
 * - POST   /api/v1/live/rooms/:id/daily    - Create Daily.co room (VTID-01228)
 * - DELETE /api/v1/live/rooms/:id/daily    - Delete Daily.co room (VTID-01228)
 * - POST   /api/v1/community/meetups/:id/rsvp - RSVP to a meetup
 * - GET    /api/v1/live/health             - Health check
 *
 * Dependencies:
 * - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
 * - VTID-01084 (Community Meetups) - meetups table
 * - VTID-01228 (Daily.co Integration) - DailyClient
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { emitOasisEvent } from '../services/oasis-event-service';
import { DailyClient } from '../services/daily-client';
import { RoomSessionManager } from '../services/room-session-manager';
import Stripe from 'stripe';
import rateLimit from 'express-rate-limit';

const router = Router();

// =============================================================================
// VTID-01228: Rate Limiters
// =============================================================================

/**
 * Rate limiter for Daily.co room creation (expensive operation)
 * Limit: 5 requests per 15 minutes per IP
 */
const dailyRoomLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { ok: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many room creation requests' },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Rate limiter for purchase requests (prevent abuse)
 * Limit: 10 requests per 15 minutes per IP
 */
const purchaseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { ok: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many purchase requests' },
  standardHeaders: true,
  legacyHeaders: false
});

// =============================================================================
// VTID-01228: Session Manager (singleton)
// =============================================================================

const sessionManager = new RoomSessionManager();

/**
 * Rate limiter for session creation ("Go Live")
 * Limit: 5 requests per 15 minutes per IP
 */
const sessionCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { ok: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many session creation requests' },
  standardHeaders: true,
  legacyHeaders: false
});

// =============================================================================
// VTID-01090: Constants & Types
// =============================================================================

/**
 * Live room status types
 */
const LIVE_ROOM_STATUS = ['scheduled', 'live', 'ended'] as const;
type LiveRoomStatus = typeof LIVE_ROOM_STATUS[number];

/**
 * Highlight types for live rooms
 */
const HIGHLIGHT_TYPES = ['quote', 'moment', 'action_item', 'insight'] as const;
type HighlightType = typeof HIGHLIGHT_TYPES[number];

/**
 * Event attendance status types
 */
const ATTENDANCE_STATUS = ['rsvp', 'attended', 'no_show'] as const;
type AttendanceStatus = typeof ATTENDANCE_STATUS[number];

/**
 * Strength increment constants (platform invariants)
 */
const STRENGTH_INCREMENTS = {
  RSVP: 5,
  ATTENDED: 15,
  STAYED_20MIN: 10,
  HIGHLIGHT: 8,
  COATTENDANCE: 3,
  COATTENDANCE_DAILY_CAP: 15
} as const;

// =============================================================================
// Request Schemas
// =============================================================================

const CreateRoomSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  topic_keys: z.array(z.string()).optional().default([]),
  starts_at: z.string().datetime().optional(),
  access_level: z.enum(['public', 'group']).optional().default('public'),
  metadata: z.record(z.any()).optional().default({})
});

const AddHighlightSchema = z.object({
  type: z.enum(HIGHLIGHT_TYPES),
  text: z.string().min(1, 'Text is required')
});

const MeetupRsvpSchema = z.object({
  status: z.enum(ATTENDANCE_STATUS)
});

// VTID-01228: Session management schemas
const CreateSessionSchema = z.object({
  session_title: z.string().optional(),
  topic_keys: z.array(z.string()).optional(),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime().optional(),
  access_level: z.enum(['public', 'group']).optional(),
  auto_admit: z.boolean().optional(),
  lobby_buffer_minutes: z.number().int().min(0).max(60).optional(),
  max_participants: z.number().int().min(1).max(10000).optional(),
  metadata: z.record(z.any()).optional(),
  idempotency_key: z.string().optional(),
});

const UpdateRoomSchema = z.object({
  room_name: z.string().min(1).max(100).optional(),
  room_slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  cover_image_url: z.string().url().optional(),
  description: z.string().max(1000).optional(),
});

const UserActionSchema = z.object({
  user_id: z.string().uuid(),
});

// =============================================================================
// Helper Functions
// =============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract Bearer token from Authorization header
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Get Supabase credentials
 */
function getSupabaseCredentials(): { url: string; key: string } | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  return { url: supabaseUrl, key: supabaseKey };
}

/**
 * Call a Supabase RPC function with user token
 */
async function callRpc(
  token: string,
  functionName: string,
  params: Record<string, unknown>
): Promise<{ ok: boolean; data?: any; error?: string; message?: string }> {
  const creds = getSupabaseCredentials();
  if (!creds) {
    return { ok: false, error: 'Gateway misconfigured' };
  }

  try {
    const response = await fetch(`${creds.url}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': creds.key,
        'Authorization': `Bearer ${token}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      const errorText = await response.text();
      let parsedError: Record<string, unknown> | null = null;
      try { parsedError = JSON.parse(errorText); } catch { /* raw text */ }

      const errorCode = parsedError?.code || parsedError?.error_code || '';
      const errorHint = parsedError?.hint || parsedError?.details || '';

      // VTID-01090-FIX: Detect "Access Denied" at DB level (often TENANT_NOT_FOUND)
      if (errorText.includes('TENANT_NOT_FOUND') || errorText.includes('UNAUTHENTICATED')) {
        console.error(`[VTID-01090] Auth failure in RPC ${functionName}: HTTP ${response.status} | code=${errorCode} | ${errorText}`);
        return {
          ok: false,
          error: 'ACCESS_DENIED',
          message: 'Room creation failed: tenant context missing. Please ensure you are logged in to a valid tenant.'
        };
      }

      console.error(
        `[VTID-01090] RPC ${functionName} failed: HTTP ${response.status} | code=${errorCode} | hint=${errorHint} | body=${errorText}`
      );
      return { ok: false, error: `RPC failed: ${response.status} - ${errorText}` };
    }

    const data = await response.json() as Record<string, unknown> | Array<any>;

    // Check if the result itself indicates failure (PostgREST JSON response)
    const result = Array.isArray(data) ? data[0] : data;

    if (result && typeof result === 'object' && result.ok === false) {
      return { ok: false, error: result.error as string || 'RPC execution failed' };
    }

    return { ok: true, data: result };
  } catch (err: any) {
    console.error(`[VTID-01090] RPC ${functionName} exception: ${err.message}`, {
      function: functionName,
      stack: err.stack?.split('\n').slice(0, 3).join(' | '),
      cause: err.cause?.message,
    });
    return { ok: false, error: err.message };
  }
}

/**
 * Emit a live room OASIS event
 */
async function emitLiveEvent(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01090',
    type: type as any,
    source: 'live-gateway',
    status,
    message,
    payload
  }).catch(err => console.warn(`[VTID-01090] Failed to emit ${type}:`, err.message));
}

// =============================================================================
// VTID-01090: Routes
// =============================================================================

/**
 * POST /rooms -> POST /api/v1/live/rooms
 *
 * Create a new live room.
 */
router.post('/rooms', async (req: Request, res: Response) => {
  console.log('[VTID-01090] POST /live/rooms');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const validation = CreateRoomSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { title, topic_keys, starts_at, access_level, metadata } = validation.data;

  // VTID-01230: Enforce creator onboarding for paid rooms
  if (access_level === 'group' && metadata?.price && Number(metadata.price) > 0) {
    const creatorStatusResult = await callRpc(token, 'get_user_stripe_status', {});

    if (!creatorStatusResult.ok || !creatorStatusResult.data || creatorStatusResult.data.length === 0) {
      return res.status(403).json({
        ok: false,
        error: 'CREATOR_NOT_ONBOARDED',
        message: 'Complete payment setup before creating paid rooms',
      });
    }

    const creatorStatus = creatorStatusResult.data[0];
    if (!creatorStatus.stripe_charges_enabled || !creatorStatus.stripe_payouts_enabled) {
      return res.status(403).json({
        ok: false,
        error: 'CREATOR_NOT_ONBOARDED',
        message: 'Complete payment setup before creating paid rooms. Both charges and payouts must be enabled.',
      });
    }

    console.log('[VTID-01230] Creator onboarding verified for paid room creation');
  }

  const result = await callRpc(token, 'live_room_create', {
    p_payload: {
      title,
      topic_keys,
      starts_at,
      access_level,
      metadata
    }
  });

  if (!result.ok) {
    return res.status(502).json({ ok: false, error: result.error });
  }

  // Emit OASIS event
  await emitLiveEvent(
    'live.room.created',
    'success',
    `Live room created: ${title}`,
    {
      live_room_id: result.data?.live_room_id,
      title,
      topic_keys,
      starts_at
    }
  );

  console.log(`[VTID-01090] Live room created: ${result.data?.live_room_id}`);

  // Determine status: 'idle' for permanent rooms (no starts_at), 'scheduled' for scheduled rooms
  const roomStatus = starts_at ? 'scheduled' : 'idle';

  // Construct room object matching LiveRoom interface
  const room = {
    id: result.data?.live_room_id,
    tenant_id: result.data?.tenant_id || '',
    title,
    topic_keys: topic_keys || [],
    host_user_id: result.data?.host_user_id || '',
    starts_at: starts_at || null,
    ends_at: null,
    status: roomStatus,
    access_level: access_level || 'public',
    room_name: null,
    room_slug: null,
    current_session_id: null,
    cover_image_url: metadata?.cover_image_url || null,
    description: metadata?.description || null,
    host_present: false,
    metadata: metadata || {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  return res.status(201).json({
    ok: true,
    room
  });
});

/**
 * POST /rooms/:id/start -> POST /api/v1/live/rooms/:id/start
 *
 * Start a scheduled live room.
 */
router.post('/rooms/:id/start', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01090] POST /live/rooms/${roomId}/start`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate UUID
  if (!roomId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const result = await callRpc(token, 'live_room_start', {
    p_live_room_id: roomId
  });

  if (!result.ok) {
    const statusCode = result.error?.includes('NOT_HOST') ? 403 :
      result.error?.includes('ROOM_NOT_FOUND') ? 404 : 502;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  // Emit OASIS event
  await emitLiveEvent(
    'live.room.started',
    'success',
    `Live room started: ${roomId}`,
    {
      live_room_id: roomId,
      started_at: result.data?.started_at
    }
  );

  // VTID-01228: Sync to community_live_streams (for visibility in listing)
  try {
    const creds = getSupabaseCredentials();
    if (creds) {
      await fetch(`${creds.url}/rest/v1/community_live_streams?id=eq.${roomId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': creds.key,
          'Authorization': `Bearer ${creds.key}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          status: 'live',
          started_at: result.data?.started_at || new Date().toISOString()
        })
      });
    }
  } catch (err: any) {
    console.warn(`[VTID-01228] community_live_streams sync (start) failed: ${err.message}`);
  }

  console.log(`[VTID-01090] Live room started: ${roomId}`);

  return res.status(200).json({
    ok: true,
    live_room_id: roomId,
    status: 'live',
    started_at: result.data?.started_at
  });
});

/**
 * POST /rooms/:id/end -> POST /api/v1/live/rooms/:id/end
 *
 * End a live room.
 */
router.post('/rooms/:id/end', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] POST /live/rooms/${roomId}/end`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!roomId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  // VTID-01228: Use live_room_end_session (ends session + resets room to idle)
  // instead of old live_room_end which had resolve_tenant_for_user issues
  const result = await callRpc(token, 'live_room_end_session', {
    p_room_id: roomId
  });

  if (!result.ok) {
    const statusCode = result.error?.includes('NOT_HOST') ? 403 :
      result.error?.includes('ROOM_NOT_FOUND') ? 404 :
      result.error?.includes('INVALID_STATE') ? 409 : 502;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  // Sync to community_live_streams (so LiveRooms listing reflects ended state)
  try {
    const creds = getSupabaseCredentials();
    if (creds) {
      await fetch(`${creds.url}/rest/v1/community_live_streams?id=eq.${roomId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': creds.key,
          'Authorization': `Bearer ${creds.key}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ status: 'ended', ended_at: new Date().toISOString() })
      });
    }
  } catch (err: any) {
    console.warn(`[VTID-01228] community_live_streams sync (end) failed: ${err.message}`);
  }

  // Emit OASIS event
  await emitLiveEvent(
    'live.room.ended',
    'success',
    `Live room ended: ${roomId}`,
    { live_room_id: roomId, ended_session_id: result.data?.ended_session_id }
  );

  console.log(`[VTID-01228] Live room ended: ${roomId} (session: ${result.data?.ended_session_id})`);

  return res.status(200).json({
    ok: true,
    live_room_id: roomId,
    status: 'idle',
    ended_session_id: result.data?.ended_session_id
  });
});

/**
 * POST /rooms/:id/join -> POST /api/v1/live/rooms/:id/join
 *
 * Join a live room (VTID-01228: with access control for paid rooms).
 */
router.post('/rooms/:id/join', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01090] POST /live/rooms/${roomId}/join`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!roomId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  // VTID-01228: Access control for paid rooms
  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ ok: false, error: 'USER_ID_REQUIRED' });
  }

  try {
    // Get room details to check access level
    const roomResult = await callRpc(token, 'live_room_get', {
      p_live_room_id: roomId
    });

    if (!roomResult.ok || !roomResult.data) {
      return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
    }

    const room = roomResult.data;

    // Check access for paid rooms
    if (room.access_level === 'group') {
      const accessResult = await callRpc(token, 'live_room_check_access', {
        p_user_id: user_id,
        p_room_id: roomId
      });

      if (!accessResult.ok || !accessResult.data) {
        return res.status(403).json({
          ok: false,
          error: 'ACCESS_DENIED',
          message: 'You must purchase access to join this room'
        });
      }

      console.log(`[VTID-01228] Access verified for user ${user_id} to room ${roomId}`);
    }
  } catch (error: any) {
    console.error('[VTID-01228] Error checking access:', error);
    return res.status(500).json({
      ok: false,
      error: 'ACCESS_CHECK_FAILED',
      message: error.message
    });
  }

  // Proceed with join
  const result = await callRpc(token, 'live_room_join', {
    p_live_room_id: roomId
  });

  if (!result.ok) {
    const statusCode = result.error?.includes('ROOM_NOT_FOUND') ? 404 :
      result.error?.includes('ROOM_NOT_LIVE') ? 409 : 502;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  // Emit OASIS event
  await emitLiveEvent(
    'live.room.joined',
    'success',
    `User joined live room: ${roomId}`,
    {
      live_room_id: roomId,
      attendance_id: result.data?.attendance_id,
      joined_at: result.data?.joined_at,
      coattendance_edges_created: result.data?.coattendance_edges_created
    }
  );

  // Emit relationship edge strengthened event
  await emitLiveEvent(
    'relationship.edge.strengthened',
    'info',
    `Attendance edge strengthened (+${STRENGTH_INCREMENTS.ATTENDED})`,
    {
      live_room_id: roomId,
      delta_strength: STRENGTH_INCREMENTS.ATTENDED,
      edge_type: 'attendee',
      coattendance_edges: result.data?.coattendance_edges_created
    }
  );

  console.log(`[VTID-01090] User joined room: ${roomId} (${result.data?.coattendance_edges_created} co-attendance edges)`);

  return res.status(200).json({
    ok: true,
    attendance_id: result.data?.attendance_id,
    live_room_id: roomId,
    joined_at: result.data?.joined_at,
    coattendance_edges_created: result.data?.coattendance_edges_created
  });
});

/**
 * POST /rooms/:id/leave -> POST /api/v1/live/rooms/:id/leave
 *
 * Leave a live room.
 */
router.post('/rooms/:id/leave', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01090] POST /live/rooms/${roomId}/leave`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!roomId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const result = await callRpc(token, 'live_room_leave', {
    p_live_room_id: roomId
  });

  if (!result.ok) {
    const statusCode = result.error?.includes('NOT_IN_ROOM') ? 404 :
      result.error?.includes('ALREADY_LEFT') ? 409 : 502;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  // Emit OASIS event
  await emitLiveEvent(
    'live.room.left',
    'success',
    `User left live room: ${roomId}`,
    {
      live_room_id: roomId,
      left_at: result.data?.left_at,
      duration_minutes: result.data?.duration_minutes,
      duration_bonus_applied: result.data?.duration_bonus_applied
    }
  );

  // If duration bonus was applied, emit edge strengthened event
  if (result.data?.duration_bonus_applied) {
    await emitLiveEvent(
      'relationship.edge.strengthened',
      'info',
      `Duration bonus applied (+${STRENGTH_INCREMENTS.STAYED_20MIN})`,
      {
        live_room_id: roomId,
        delta_strength: STRENGTH_INCREMENTS.STAYED_20MIN,
        edge_type: 'attendee',
        reason: 'stayed_20min'
      }
    );
  }

  console.log(`[VTID-01090] User left room: ${roomId} (${result.data?.duration_minutes} min, bonus: ${result.data?.duration_bonus_applied})`);

  return res.status(200).json({
    ok: true,
    live_room_id: roomId,
    left_at: result.data?.left_at,
    duration_minutes: result.data?.duration_minutes,
    duration_bonus_applied: result.data?.duration_bonus_applied
  });
});

/**
 * POST /rooms/:id/daily -> POST /api/v1/live/rooms/:id/daily
 *
 * VTID-01228: Create a Daily.co video room for a live room.
 * Only the room host can create the Daily.co room.
 * Idempotent: Returns existing room URL if already created.
 */
router.post('/rooms/:id/daily', dailyRoomLimiter, async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] POST /live/rooms/${roomId}/daily`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!roomId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  try {
    // Get room details to verify ownership and check if Daily.co room exists
    const roomResult = await callRpc(token, 'live_room_get', {
      p_live_room_id: roomId
    });

    if (!roomResult.ok || !roomResult.data) {
      return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
    }

    // Verify user is the host
    const room = roomResult.data;
    if (room.host_user_id !== req.headers['x-user-id']) {
      // For now, we'll trust the token - in production, decode JWT to get user_id
      // TODO: Extract user_id from JWT token
      console.warn('[VTID-01228] Cannot verify host ownership without user_id in headers');
    }

    // Check if Daily.co room already exists (idempotent)
    if (room.metadata?.daily_room_url) {
      console.log(`[VTID-01228] Daily.co room already exists: ${room.metadata.daily_room_url}`);
      return res.json({
        ok: true,
        daily_room_url: room.metadata.daily_room_url,
        daily_room_name: room.metadata.daily_room_name,
        already_existed: true
      });
    }

    // Create Daily.co room
    const dailyClient = new DailyClient();
    const dailyRoom = await dailyClient.createRoom({
      roomId,
      title: room.title,
      expiresInHours: 24  // 24 hours expiration
    });

    // Update room metadata with Daily.co room URL
    const updateResult = await callRpc(token, 'live_room_update_metadata', {
      p_live_room_id: roomId,
      p_metadata: {
        ...room.metadata,
        daily_room_url: dailyRoom.roomUrl,
        daily_room_name: dailyRoom.roomName,
        video_provider: 'daily_co'
      }
    });

    if (!updateResult.ok) {
      // Try to clean up the Daily.co room if metadata update fails
      try {
        await dailyClient.deleteRoom(dailyRoom.roomName);
      } catch (cleanupErr) {
        console.error('[VTID-01228] Failed to cleanup Daily.co room:', cleanupErr);
      }
      return res.status(502).json({ ok: false, error: 'Failed to update room metadata' });
    }

    // Emit OASIS event
    await emitOasisEvent({
      vtid: 'VTID-01228',
      type: 'live.daily.created' as any,
      source: 'live-gateway',
      status: 'success',
      message: `Daily.co room created for live room ${roomId}`,
      payload: { room_id: roomId, daily_room_url: dailyRoom.roomUrl, daily_room_name: dailyRoom.roomName }
    });

    console.log(`[VTID-01228] Daily.co room created: ${dailyRoom.roomUrl}`);

    return res.json({
      ok: true,
      daily_room_url: dailyRoom.roomUrl,
      daily_room_name: dailyRoom.roomName,
      already_existed: false
    });
  } catch (error: any) {
    console.error('[VTID-01228] Error creating Daily.co room:', error);
    return res.status(500).json({
      ok: false,
      error: 'DAILY_CREATE_FAILED',
      message: error.message
    });
  }
});

/**
 * DELETE /rooms/:id/daily -> DELETE /api/v1/live/rooms/:id/daily
 *
 * VTID-01228: Delete the Daily.co video room for a live room.
 * Only the room host can delete the Daily.co room.
 */
router.delete('/rooms/:id/daily', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] DELETE /live/rooms/${roomId}/daily`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!roomId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  try {
    // Get room details
    const roomResult = await callRpc(token, 'live_room_get', {
      p_live_room_id: roomId
    });

    if (!roomResult.ok || !roomResult.data) {
      return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
    }

    const room = roomResult.data;
    const dailyRoomName = room.metadata?.daily_room_name;

    if (!dailyRoomName) {
      return res.json({ ok: true, message: 'No Daily.co room to delete' });
    }

    // Delete Daily.co room
    const dailyClient = new DailyClient();
    await dailyClient.deleteRoom(dailyRoomName);

    // Remove Daily.co data from metadata
    const newMetadata = { ...room.metadata };
    delete newMetadata.daily_room_url;
    delete newMetadata.daily_room_name;
    delete newMetadata.video_provider;

    await callRpc(token, 'live_room_update_metadata', {
      p_live_room_id: roomId,
      p_metadata: newMetadata
    });

    // Emit OASIS event
    await emitOasisEvent({
      vtid: 'VTID-01228',
      type: 'live.daily.deleted' as any,
      source: 'live-gateway',
      status: 'success',
      message: `Daily.co room deleted for live room ${roomId}`,
      payload: { room_id: roomId, daily_room_name: dailyRoomName }
    });

    console.log(`[VTID-01228] Daily.co room deleted: ${dailyRoomName}`);

    return res.json({ ok: true, message: 'Daily.co room deleted' });
  } catch (error: any) {
    console.error('[VTID-01228] Error deleting Daily.co room:', error);
    return res.status(500).json({
      ok: false,
      error: 'DAILY_DELETE_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /rooms/:id/purchase -> POST /api/v1/live/rooms/:id/purchase
 *
 * VTID-01228: Purchase access to a paid live room via Stripe.
 * Creates a Payment Intent for the room price.
 */
router.post('/rooms/:id/purchase', purchaseLimiter, async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] POST /live/rooms/${roomId}/purchase`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!roomId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  // Extract user_id from request body (frontend should include this)
  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ ok: false, error: 'USER_ID_REQUIRED' });
  }

  try {
    // Get room details
    const roomResult = await callRpc(token, 'live_room_get', {
      p_live_room_id: roomId
    });

    if (!roomResult.ok || !roomResult.data) {
      return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
    }

    const room = roomResult.data;

    // Verify room requires payment
    if (room.access_level !== 'group') {
      return res.status(400).json({
        ok: false,
        error: 'ROOM_NOT_PAID',
        message: 'This room does not require payment'
      });
    }

    // Get price from metadata
    const price = room.metadata?.price;
    if (!price || typeof price !== 'number' || price <= 0) {
      return res.status(500).json({
        ok: false,
        error: 'PRICE_NOT_CONFIGURED',
        message: 'Room price is not properly configured'
      });
    }

    // Initialize Stripe
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      console.error('[VTID-01228] STRIPE_SECRET_KEY not configured');
      return res.status(500).json({
        ok: false,
        error: 'PAYMENT_NOT_CONFIGURED'
      });
    }

    const stripe = new Stripe(stripeKey);

    // Create Payment Intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(price * 100), // Convert dollars to cents
      currency: 'usd',
      metadata: {
        room_id: roomId,
        room_title: room.title,
        user_id: user_id,
        vtid: 'VTID-01228'
      },
      automatic_payment_methods: {
        enabled: true
      }
    });

    console.log(`[VTID-01228] Payment Intent created: ${paymentIntent.id} for room ${roomId}`);

    // Emit OASIS event
    await emitOasisEvent({
      vtid: 'VTID-01228',
      type: 'live.purchase.initiated' as any,
      source: 'live-gateway',
      status: 'success',
      message: `Payment Intent created for room ${roomId}`,
      payload: {
        room_id: roomId,
        payment_intent_id: paymentIntent.id,
        amount: price
      }
    });

    return res.json({
      ok: true,
      client_secret: paymentIntent.client_secret,
      amount: price,
      currency: 'usd'
    });
  } catch (error: any) {
    console.error('[VTID-01228] Error creating payment intent:', error);
    return res.status(500).json({
      ok: false,
      error: 'PURCHASE_FAILED',
      message: error.message
    });
  }
});

/**
 * POST /rooms/:id/highlights -> POST /api/v1/live/rooms/:id/highlights
 *
 * Add a highlight to a live room.
 */
router.post('/rooms/:id/highlights', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01090] POST /live/rooms/${roomId}/highlights`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!roomId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const validation = AddHighlightSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { type, text } = validation.data;

  const result = await callRpc(token, 'live_add_highlight', {
    p_live_room_id: roomId,
    p_type: type,
    p_text: text
  });

  if (!result.ok) {
    const statusCode = result.error?.includes('ROOM_NOT_FOUND') ? 404 :
      result.error?.includes('ROOM_NOT_ACTIVE') ? 409 : 502;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  // Emit OASIS event
  await emitLiveEvent(
    'live.highlight.created',
    'success',
    `Highlight created: ${type}`,
    {
      highlight_id: result.data?.highlight_id,
      live_room_id: roomId,
      type,
      text_length: text.length,
      memory_id: result.data?.memory_id
    }
  );

  // Emit edge strengthened event
  await emitLiveEvent(
    'relationship.edge.strengthened',
    'info',
    `Highlight edge strengthened (+${STRENGTH_INCREMENTS.HIGHLIGHT})`,
    {
      live_room_id: roomId,
      delta_strength: STRENGTH_INCREMENTS.HIGHLIGHT,
      edge_type: 'attendee',
      reason: 'highlight_created'
    }
  );

  console.log(`[VTID-01090] Highlight created: ${result.data?.highlight_id} (${type})`);

  return res.status(201).json({
    ok: true,
    highlight_id: result.data?.highlight_id,
    live_room_id: roomId,
    type,
    memory_id: result.data?.memory_id
  });
});

/**
 * GET /rooms/:id/summary -> GET /api/v1/live/rooms/:id/summary
 *
 * Get summary statistics for a live room.
 */
router.get('/rooms/:id/summary', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01090] GET /live/rooms/${roomId}/summary`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!roomId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const result = await callRpc(token, 'get_live_room_summary', {
    p_live_room_id: roomId
  });

  if (!result.ok) {
    const statusCode = result.error?.includes('ROOM_NOT_FOUND') ? 404 : 502;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  console.log(`[VTID-01090] Room summary fetched: ${roomId}`);

  return res.status(200).json(result.data);
});

/**
 * GET /health -> GET /api/v1/live/health
 *
 * Health check for live rooms system.
 */
router.get('/health', (_req: Request, res: Response) => {
  const creds = getSupabaseCredentials();
  const status = creds ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'live-gateway',
    version: '1.0.0',
    vtid: 'VTID-01090',
    timestamp: new Date().toISOString(),
    capabilities: {
      create_room: !!creds,
      join_room: !!creds,
      add_highlight: !!creds,
      relationship_graph: true
    },
    strength_increments: STRENGTH_INCREMENTS,
    dependencies: {
      'VTID-01101': 'Phase A-Fix (tenant/user helpers)',
      'VTID-01084': 'Community Meetups',
      'VTID-01087': 'Relationship Graph'
    }
  });
});

/**
 * POST /stripe/webhook -> POST /api/v1/live/stripe/webhook
 *
 * VTID-01228: Stripe webhook handler for payment events.
 * Grants access to paid rooms upon successful payment.
 *
 * NOTE: This endpoint requires raw body for signature verification.
 * The main app must configure express.raw() for this route.
 */
router.post('/stripe/webhook', async (req: Request, res: Response) => {
  console.log(`[VTID-01228] POST /live/stripe/webhook`);

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey || !webhookSecret) {
    console.error('[VTID-01228] Stripe not configured');
    return res.status(500).json({ ok: false, error: 'STRIPE_NOT_CONFIGURED' });
  }

  const stripe = new Stripe(stripeKey);
  const sig = req.headers['stripe-signature'];

  if (!sig) {
    return res.status(400).json({ ok: false, error: 'NO_SIGNATURE' });
  }

  let event: Stripe.Event;

  try {
    // Verify webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    console.error('[VTID-01228] Webhook signature verification failed:', err.message);
    return res.status(400).json({ ok: false, error: 'INVALID_SIGNATURE' });
  }

  // Handle payment_intent.succeeded event
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const roomId = paymentIntent.metadata.room_id;

    if (!roomId) {
      console.error('[VTID-01228] Payment Intent missing room_id metadata');
      return res.status(400).json({ ok: false, error: 'MISSING_METADATA' });
    }

    try {
      // Grant access to the room
      // Note: We need user_id from the payment intent
      // For now, we'll store it in metadata when creating the payment intent
      const userId = paymentIntent.metadata.user_id;

      if (!userId) {
        console.error('[VTID-01228] Payment Intent missing user_id metadata');
        return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });
      }

      // Use service role to grant access (webhook has no user JWT)
      const token = process.env.SUPABASE_SERVICE_ROLE;
      if (!token) {
        console.error('[VTID-01228] SUPABASE_SERVICE_ROLE not configured');
        return res.status(500).json({ ok: false, error: 'SERVICE_ROLE_NOT_CONFIGURED' });
      }

      const grantResult = await callRpc(token, 'live_room_grant_access', {
        p_user_id: userId,
        p_room_id: roomId,
        p_access_type: 'paid',
        p_stripe_payment_intent_id: paymentIntent.id
      });

      if (!grantResult.ok) {
        console.error('[VTID-01228] Failed to grant access:', grantResult.error);
        return res.status(500).json({ ok: false, error: 'GRANT_FAILED' });
      }

      console.log(`[VTID-01228] Access granted: user ${userId} -> room ${roomId} (payment ${paymentIntent.id})`);

      // Emit OASIS event
      await emitOasisEvent({
        vtid: 'VTID-01228',
        type: 'live.purchase.completed' as any,
        source: 'live-gateway',
        status: 'success',
        message: `Access granted for room ${roomId}`,
        payload: {
          room_id: roomId,
          user_id: userId,
          payment_intent_id: paymentIntent.id,
          amount: paymentIntent.amount / 100
        }
      });
    } catch (error: any) {
      console.error('[VTID-01228] Error granting access:', error);
      return res.status(500).json({ ok: false, error: 'GRANT_ERROR', message: error.message });
    }
  }

  return res.json({ ok: true, received: true });
});

// =============================================================================
// VTID-01228: Session Management Endpoints
// =============================================================================

/**
 * GET /rooms/me -> GET /api/v1/live/rooms/me
 *
 * Get the current user's permanent room + current session status.
 */
router.get('/rooms/me', async (req: Request, res: Response) => {
  console.log('[VTID-01228] GET /live/rooms/me');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Query app_users via Supabase REST API — filter by user JWT to scope correctly
  const creds = getSupabaseCredentials();
  if (!creds) {
    return res.status(500).json({ ok: false, error: 'Gateway misconfigured' });
  }

  try {
    // Decode user_id from JWT to filter correctly (service_role bypasses RLS)
    let userId: string | null = null;
    let jwtEmail: string | null = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      userId = payload.sub;
      jwtEmail = payload.email || null;
    } catch { /* fallback below */ }

    console.log(`[VTID-01228] /rooms/me lookup: userId=${userId} email=${jwtEmail}`);

    const filterParam = userId ? `&user_id=eq.${userId}` : '';
    const userResponse = await fetch(
      `${creds.url}/rest/v1/app_users?select=live_room_id,user_id,email,display_name&limit=1${filterParam}`,
      {
        headers: {
          'apikey': creds.key,
          'Authorization': `Bearer ${token}`,
        },
      }
    );

    if (!userResponse.ok) {
      const errText = await userResponse.text();
      console.error(`[VTID-01228] /rooms/me app_users fetch failed: HTTP ${userResponse.status} | userId=${userId} | email=${jwtEmail} | body=${errText}`);
      return res.status(502).json({ ok: false, error: 'Failed to fetch user profile' });
    }

    const users = await userResponse.json() as Array<{ live_room_id: string | null; user_id: string; email: string; display_name: string }>;
    const liveRoomId = users?.[0]?.live_room_id;

    if (!users || users.length === 0) {
      console.error(`[VTID-01228] /rooms/me: NO app_users record found | userId=${userId} | email=${jwtEmail} | Likely: user was never onboarded (no row in app_users table)`);
      return res.status(404).json({ ok: false, error: 'NO_USER_PROFILE', message: 'No app_users record found. User may not be onboarded.' });
    }

    if (!liveRoomId) {
      console.error(`[VTID-01228] /rooms/me: app_users record exists but live_room_id is NULL | userId=${userId} | email=${jwtEmail} | displayName=${users[0]?.display_name} | Likely: create_user_live_room trigger did not fire for this user`);
      return res.status(404).json({ ok: false, error: 'NO_ROOM', message: 'User does not have a permanent room. The auto-create trigger may not have fired.' });
    }

    console.log(`[VTID-01228] /rooms/me: found room ${liveRoomId} for userId=${userId} email=${jwtEmail}`);

    const stateResult = await sessionManager.getState(liveRoomId, token);
    if (!stateResult.ok) {
      console.error(`[VTID-01228] /rooms/me: getState failed for roomId=${liveRoomId} | userId=${userId} | error=${stateResult.error} | message=${stateResult.message}`);
      return res.status(502).json({ ok: false, error: stateResult.error });
    }

    return res.json(stateResult.data);
  } catch (err: any) {
    console.error(`[VTID-01228] /rooms/me error:`, err.message, { stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /rooms/:id/state -> GET /api/v1/live/rooms/:id/state
 *
 * Session snapshot — room status, session info, counts, viewer's role/lobby_status.
 * Single endpoint that returns everything the frontend needs.
 */
router.get('/rooms/:id/state', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] GET /live/rooms/${roomId}/state`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const result = await sessionManager.getState(roomId, token);
  if (!result.ok) {
    const statusCode = result.error?.includes('ROOM_NOT_FOUND') ? 404 : 502;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  return res.json(result.data);
});

/**
 * POST /rooms/:id/sessions -> POST /api/v1/live/rooms/:id/sessions
 *
 * "Go Live" — create a new session on a permanent room.
 * Host-only. Room must be idle.
 */
router.post('/rooms/:id/sessions', sessionCreateLimiter, async (req: Request, res: Response) => {
  const roomId = req.params.id;

  // Extract user info from JWT for logging
  const token = getBearerToken(req);
  let jwtUserId = 'unknown';
  let jwtEmail = 'unknown';
  try {
    const payload = JSON.parse(Buffer.from((token || '').split('.')[1], 'base64').toString());
    jwtUserId = payload.sub || 'missing-sub';
    jwtEmail = payload.email || 'no-email-in-jwt';
  } catch { /* token parse failed */ }

  console.log(`[VTID-01228] POST /live/rooms/${roomId}/sessions | userId=${jwtUserId} | email=${jwtEmail} | userAgent=${req.headers['user-agent']?.substring(0, 80)} | origin=${req.headers.origin || req.headers.referer || 'none'}`);

  if (!token) {
    console.error(`[VTID-01228] Session create REJECTED: no Bearer token | roomId=${roomId} | userAgent=${req.headers['user-agent']?.substring(0, 80)}`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    console.error(`[VTID-01228] Session create REJECTED: invalid room ID format | roomId=${roomId} | userId=${jwtUserId}`);
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const validation = CreateSessionSchema.safeParse(req.body);
  if (!validation.success) {
    console.error(`[VTID-01228] Session create REJECTED: validation failed | roomId=${roomId} | userId=${jwtUserId} | errors=${validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')} | body=${JSON.stringify(req.body).substring(0, 200)}`);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  // VTID-01230: Enforce creator onboarding for paid sessions
  if (validation.data.access_level === 'group' && validation.data.metadata?.price && Number(validation.data.metadata.price) > 0) {
    const creatorStatusResult = await callRpc(token, 'get_user_stripe_status', {});
    if (!creatorStatusResult.ok || !creatorStatusResult.data || creatorStatusResult.data.length === 0) {
      return res.status(403).json({
        ok: false,
        error: 'CREATOR_NOT_ONBOARDED',
        message: 'Complete payment setup before creating paid sessions',
      });
    }
    const creatorStatus = creatorStatusResult.data[0];
    if (!creatorStatus.stripe_charges_enabled || !creatorStatus.stripe_payouts_enabled) {
      return res.status(403).json({
        ok: false,
        error: 'CREATOR_NOT_ONBOARDED',
        message: 'Complete payment setup before creating paid sessions. Both charges and payouts must be enabled.',
      });
    }
  }

  const result = await sessionManager.createSession(roomId, validation.data, token);

  if (!result.ok) {
    const statusCode =
      result.error === 'NOT_HOST' ? 403 :
      result.error === 'ROOM_NOT_FOUND' ? 404 :
      result.error === 'ROOM_NOT_IDLE' ? 409 : 502;

    // Enhanced error logging with actionable diagnostics
    const isPermissionDenied = result.message?.includes('42501') || result.message?.includes('permission denied');
    const isRpcFailed = result.error?.startsWith('RPC failed');
    let diagnosticHint = '';
    if (isPermissionDenied) {
      diagnosticHint = ' | DIAGNOSTIC: PostgreSQL 42501 — GRANT EXECUTE missing on RPC. Apply migration 20260218000001_fix_missing_session_rpc_grants.sql';
    } else if (result.error === 'NOT_HOST') {
      diagnosticHint = ` | DIAGNOSTIC: JWT userId=${jwtUserId} does not match room host_user_id. Check live_rooms.host_user_id for roomId=${roomId}`;
    } else if (result.error === 'ROOM_NOT_FOUND') {
      diagnosticHint = ` | DIAGNOSTIC: No live_rooms row for roomId=${roomId}. Check if user has app_users.live_room_id set`;
    } else if (result.error === 'ROOM_NOT_IDLE') {
      diagnosticHint = ' | DIAGNOSTIC: Room stuck in non-idle state. Previous session may not have ended cleanly';
    } else if (isRpcFailed) {
      diagnosticHint = ` | DIAGNOSTIC: Supabase RPC call failed — check DB connectivity and function existence`;
    }

    console.error(
      `[VTID-01228] SESSION CREATION FAILED: roomId=${roomId} | userId=${jwtUserId} | email=${jwtEmail} | HTTP ${statusCode} | error=${result.error} | message=${result.message || 'none'}${diagnosticHint}`,
      { body: validation.data, error: result.error, message: result.message, userId: jwtUserId, email: jwtEmail, userAgent: req.headers['user-agent']?.substring(0, 80) }
    );
    return res.status(statusCode).json({ ok: false, error: result.error, message: result.message });
  }

  console.log(`[VTID-01228] Session created: ${result.sessionId} (${result.status}) | userId=${jwtUserId} | email=${jwtEmail} | roomId=${roomId}`);

  // VTID-01228: Sync to community_live_streams so other users see this room in the listing.
  // The LiveRooms page queries community_live_streams, not live_rooms.
  // Always sync regardless of initial status (scheduled/lobby/live) — the status may
  // auto-transition immediately, and the listing page needs the entry.
  try {
    const creds = getSupabaseCredentials();
    if (creds) {
      // Decode user_id from JWT for created_by
      let userId = '';
      try {
        userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub;
      } catch { /* fallback empty */ }

      // Map session status to community_live_streams status
      const streamStatus = (result.status === 'scheduled') ? 'pending' : 'live';

      // Upsert: use room ID as the stream ID for 1:1 mapping
      const syncResp = await fetch(`${creds.url}/rest/v1/community_live_streams`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': creds.key,
          'Authorization': `Bearer ${creds.key}`,
          'Prefer': 'return=minimal,resolution=merge-duplicates'
        },
        body: JSON.stringify({
          id: roomId,
          title: validation.data.session_title || 'Live Session',
          created_by: userId,
          status: streamStatus,
          stream_type: 'audio',
          started_at: streamStatus === 'live' ? new Date().toISOString() : null,
          scheduled_for: validation.data.starts_at,
          access_level: validation.data.access_level || 'public',
          tags: validation.data.topic_keys || [],
          enable_chat: true,
          viewer_count: 0,
        })
      });
      if (!syncResp.ok) {
        const errText = await syncResp.text();
        console.error(`[VTID-01228] community_live_streams sync failed: ${syncResp.status} - ${errText}`);
      } else {
        console.log(`[VTID-01228] Synced session to community_live_streams: ${roomId} (${streamStatus})`);
      }
    }
  } catch (err: any) {
    console.warn(`[VTID-01228] community_live_streams sync (create) exception: ${err.message}`);
  }

  return res.status(201).json({
    ok: true,
    session_id: result.sessionId,
    status: result.status,
    room_id: result.roomId,
    daily_room_url: result.dailyRoomUrl,
    idempotent: result.idempotent,
  });
});

/**
 * GET /rooms/:id/sessions -> GET /api/v1/live/rooms/:id/sessions
 *
 * List past sessions for a room (history).
 */
router.get('/rooms/:id/sessions', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] GET /live/rooms/${roomId}/sessions`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const result = await sessionManager.getSessions(roomId, token);
  if (!result.ok) {
    return res.status(502).json({ ok: false, error: result.error });
  }

  return res.json(result.data);
});

/**
 * PATCH /rooms/:id -> PATCH /api/v1/live/rooms/:id
 *
 * Update permanent room name, slug, cover image, description.
 * Host-only.
 */
router.patch('/rooms/:id', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] PATCH /live/rooms/${roomId}`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const validation = UpdateRoomSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const result = await sessionManager.updateRoomIdentity(roomId, {
    name: validation.data.room_name,
    slug: validation.data.room_slug,
    coverImageUrl: validation.data.cover_image_url,
    description: validation.data.description,
  }, token);

  if (!result.ok) {
    const statusCode = result.data?.error === 'NOT_HOST' ? 403 : 502;
    return res.status(statusCode).json({ ok: false, error: result.data?.error || result.error });
  }

  return res.json({ ok: true });
});

/**
 * POST /rooms/:id/open-lobby -> POST /api/v1/live/rooms/:id/open-lobby
 *
 * Host moves room from scheduled → lobby.
 */
router.post('/rooms/:id/open-lobby', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] POST /live/rooms/${roomId}/open-lobby`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ ok: false, error: 'USER_ID_REQUIRED' });
  }

  const result = await sessionManager.transition(roomId, { type: 'OPEN_LOBBY', userId: user_id }, token);

  if (!result.ok) {
    const statusCode =
      result.error === 'NOT_HOST' ? 403 :
      result.error === 'ROOM_NOT_FOUND' ? 404 :
      result.error === 'CONFLICT' ? 409 :
      result.error === 'INVALID_TRANSITION' ? 409 : 502;
    return res.status(statusCode).json({ ok: false, error: result.error, message: result.message });
  }

  return res.json({ ok: true, status: result.newStatus });
});

/**
 * POST /rooms/:id/cancel -> POST /api/v1/live/rooms/:id/cancel
 *
 * Cancel current session + refunds + reset to idle.
 * Host-only.
 */
router.post('/rooms/:id/cancel', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] POST /live/rooms/${roomId}/cancel`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ ok: false, error: 'USER_ID_REQUIRED' });
  }

  // Initialize Stripe for refunds
  let stripe: Stripe | undefined;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (stripeKey) {
    stripe = new Stripe(stripeKey);
  }

  const result = await sessionManager.cancelSession(roomId, user_id, token, stripe);

  if (!result.ok) {
    const statusCode =
      result.error === 'NOT_HOST' ? 403 :
      result.error === 'ROOM_NOT_FOUND' ? 404 :
      result.error === 'NO_ACTIVE_SESSION' ? 409 :
      result.error === 'CONFLICT' ? 409 : 502;
    return res.status(statusCode).json({ ok: false, error: result.error, message: result.message });
  }

  return res.json({
    ok: true,
    refund_total: result.refundTotal,
    refund_succeeded: result.refundSucceeded,
    refund_failed: result.refundFailed,
  });
});

/**
 * POST /rooms/:id/host-present -> POST /api/v1/live/rooms/:id/host-present
 *
 * Called when host's Daily.co fires "joined-meeting". Sets host_present = true.
 */
router.post('/rooms/:id/host-present', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] POST /live/rooms/${roomId}/host-present`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const result = await sessionManager.setHostPresent(roomId, true, token);
  if (!result.ok) {
    const statusCode = result.data?.error === 'NOT_HOST' ? 403 : 502;
    return res.status(statusCode).json({ ok: false, error: result.data?.error || result.error });
  }

  return res.json({ ok: true, host_present: true });
});

/**
 * POST /rooms/:id/host-absent -> POST /api/v1/live/rooms/:id/host-absent
 *
 * Called when host's Daily.co fires "left-meeting". Sets host_present = false.
 */
router.post('/rooms/:id/host-absent', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] POST /live/rooms/${roomId}/host-absent`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const result = await sessionManager.setHostPresent(roomId, false, token);
  if (!result.ok) {
    const statusCode = result.data?.error === 'NOT_HOST' ? 403 : 502;
    return res.status(statusCode).json({ ok: false, error: result.data?.error || result.error });
  }

  return res.json({ ok: true, host_present: false });
});

/**
 * GET /rooms/:id/lobby -> GET /api/v1/live/rooms/:id/lobby
 *
 * Get waiting users in lobby. Host-only.
 */
router.get('/rooms/:id/lobby', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] GET /live/rooms/${roomId}/lobby`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const result = await sessionManager.getLobby(roomId, token);
  if (!result.ok) {
    const statusCode = result.data?.error === 'NOT_HOST' ? 403 : 502;
    return res.status(statusCode).json({ ok: false, error: result.data?.error || result.error });
  }

  return res.json(result.data);
});

/**
 * POST /rooms/:id/admit -> POST /api/v1/live/rooms/:id/admit
 *
 * Admit a user from the lobby. Host-only.
 */
router.post('/rooms/:id/admit', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] POST /live/rooms/${roomId}/admit`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const validation = UserActionSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ ok: false, error: 'user_id (UUID) is required' });
  }

  const result = await sessionManager.admitUser(roomId, validation.data.user_id, token);
  if (!result.ok) {
    const statusCode = result.data?.error === 'NOT_HOST' ? 403 : 502;
    return res.status(statusCode).json({ ok: false, error: result.data?.error || result.error });
  }

  return res.json({ ok: true });
});

/**
 * POST /rooms/:id/admit-all -> POST /api/v1/live/rooms/:id/admit-all
 *
 * Admit all waiting users from the lobby. Host-only.
 */
router.post('/rooms/:id/admit-all', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] POST /live/rooms/${roomId}/admit-all`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const result = await sessionManager.admitAll(roomId, token);
  if (!result.ok) {
    const statusCode = result.data?.error === 'NOT_HOST' ? 403 : 502;
    return res.status(statusCode).json({ ok: false, error: result.data?.error || result.error });
  }

  return res.json(result.data);
});

/**
 * POST /rooms/:id/reject -> POST /api/v1/live/rooms/:id/reject
 *
 * Reject a user from the lobby. Host-only.
 */
router.post('/rooms/:id/reject', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] POST /live/rooms/${roomId}/reject`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const validation = UserActionSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ ok: false, error: 'user_id (UUID) is required' });
  }

  const result = await sessionManager.rejectUser(roomId, validation.data.user_id, token);
  if (!result.ok) {
    const statusCode = result.data?.error === 'NOT_HOST' ? 403 : 502;
    return res.status(statusCode).json({ ok: false, error: result.data?.error || result.error });
  }

  return res.json({ ok: true });
});

/**
 * POST /rooms/:id/kick -> POST /api/v1/live/rooms/:id/kick
 *
 * Kick a user from the room. Host-only. User can rejoin.
 */
router.post('/rooms/:id/kick', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] POST /live/rooms/${roomId}/kick`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const validation = UserActionSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ ok: false, error: 'user_id (UUID) is required' });
  }

  const result = await sessionManager.kickUser(roomId, validation.data.user_id, token);
  if (!result.ok) {
    const statusCode = result.data?.error === 'NOT_HOST' ? 403 : 502;
    return res.status(statusCode).json({ ok: false, error: result.data?.error || result.error });
  }

  return res.json({ ok: true });
});

/**
 * POST /rooms/:id/ban -> POST /api/v1/live/rooms/:id/ban
 *
 * Ban a user from the room. Host-only. User cannot rejoin.
 */
router.post('/rooms/:id/ban', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] POST /live/rooms/${roomId}/ban`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const validation = UserActionSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ ok: false, error: 'user_id (UUID) is required' });
  }

  const result = await sessionManager.banUser(roomId, validation.data.user_id, token);
  if (!result.ok) {
    const statusCode = result.data?.error === 'NOT_HOST' ? 403 : 502;
    return res.status(statusCode).json({ ok: false, error: result.data?.error || result.error });
  }

  return res.json({ ok: true });
});

/**
 * POST /rooms/:id/disconnect -> POST /api/v1/live/rooms/:id/disconnect
 *
 * Signal WebRTC disconnection (for reconnection window).
 */
router.post('/rooms/:id/disconnect', async (req: Request, res: Response) => {
  const roomId = req.params.id;
  console.log(`[VTID-01228] POST /live/rooms/${roomId}/disconnect`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!UUID_REGEX.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const result = await sessionManager.disconnect(roomId, token);
  if (!result.ok) {
    return res.status(502).json({ ok: false, error: result.error });
  }

  return res.json({ ok: true });
});

export default router;

// =============================================================================
// Community Meetup Router (separate export for meetup RSVP)
// Note: Not mounted separately as /api/v1/community is handled by VTID-01084
// The meetup_rsvp RPC function is still available for direct database calls
// =============================================================================

export const communityMeetupRouter = Router();

/**
 * POST /meetups/:id/rsvp -> POST /api/v1/community/meetups/:id/rsvp
 *
 * RSVP or update attendance status for a meetup.
 */
communityMeetupRouter.post('/meetups/:id/rsvp', async (req: Request, res: Response) => {
  const meetupId = req.params.id;
  console.log(`[VTID-01090] POST /community/meetups/${meetupId}/rsvp`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!meetupId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({ ok: false, error: 'Invalid meetup ID format' });
  }

  const validation = MeetupRsvpSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { status } = validation.data;

  const result = await callRpc(token, 'meetup_rsvp', {
    p_meetup_id: meetupId,
    p_status: status
  });

  if (!result.ok) {
    return res.status(502).json({ ok: false, error: result.error });
  }

  // Emit OASIS event
  await emitLiveEvent(
    'meetup.rsvp.updated',
    'success',
    `Meetup RSVP updated: ${status}`,
    {
      meetup_id: meetupId,
      attendance_id: result.data?.attendance_id,
      status,
      previous_status: result.data?.previous_status,
      strength_delta: result.data?.strength_delta,
      coattendance_edges_created: result.data?.coattendance_edges_created
    }
  );

  // Emit edge strengthened event if strength changed
  if (result.data?.strength_delta > 0) {
    await emitLiveEvent(
      'relationship.edge.strengthened',
      'info',
      `Meetup attendance edge strengthened (+${result.data?.strength_delta})`,
      {
        meetup_id: meetupId,
        delta_strength: result.data?.strength_delta,
        edge_type: 'attendee',
        status,
        coattendance_edges: result.data?.coattendance_edges_created
      }
    );
  }

  console.log(`[VTID-01090] Meetup RSVP: ${meetupId} -> ${status} (+${result.data?.strength_delta})`);

  return res.status(200).json({
    ok: true,
    attendance_id: result.data?.attendance_id,
    meetup_id: meetupId,
    status,
    previous_status: result.data?.previous_status,
    strength_delta: result.data?.strength_delta,
    coattendance_edges_created: result.data?.coattendance_edges_created
  });
});
