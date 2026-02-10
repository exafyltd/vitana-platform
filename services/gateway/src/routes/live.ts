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

// =============================================================================
// Helper Functions
// =============================================================================

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

      // VTID-01090-FIX: Detect "Access Denied" at DB level (often TENANT_NOT_FOUND)
      if (errorText.includes('TENANT_NOT_FOUND') || errorText.includes('UNAUTHENTICATED')) {
        console.error(`[VTID-01090] Auth failure in RPC ${functionName}: ${errorText}`);
        return {
          ok: false,
          error: 'ACCESS_DENIED',
          message: 'Room creation failed: tenant context missing. Please ensure you are logged in to a valid tenant.'
        };
      }

      console.error(`[VTID-01090] RPC ${functionName} failed: ${response.status} - ${errorText}`);
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
    console.error(`[VTID-01090] RPC ${functionName} exception:`, err.message);
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

  return res.status(201).json({
    ok: true,
    live_room_id: result.data?.live_room_id,
    title,
    status: 'scheduled'
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
  console.log(`[VTID-01090] POST /live/rooms/${roomId}/end`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  if (!roomId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID format' });
  }

  const result = await callRpc(token, 'live_room_end', {
    p_live_room_id: roomId
  });

  if (!result.ok) {
    const statusCode = result.error?.includes('NOT_HOST') ? 403 :
      result.error?.includes('ROOM_NOT_FOUND') ? 404 : 502;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  // Emit OASIS event
  await emitLiveEvent(
    'live.room.ended',
    'success',
    `Live room ended: ${roomId}`,
    {
      live_room_id: roomId,
      ended_at: result.data?.ended_at,
      edges_strengthened: result.data?.edges_strengthened
    }
  );

  console.log(`[VTID-01090] Live room ended: ${roomId} (${result.data?.edges_strengthened} edges strengthened)`);

  return res.status(200).json({
    ok: true,
    live_room_id: roomId,
    status: 'ended',
    ended_at: result.data?.ended_at,
    edges_strengthened: result.data?.edges_strengthened
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
