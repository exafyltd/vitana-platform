/**
 * VTID-01228: Room Session Manager
 *
 * Core business logic for live room session lifecycle.
 * Sits between Gateway routes (live.ts) and database RPCs.
 *
 * Responsibilities:
 * - Enforce host authorization before state machine events
 * - Hydrate XState machine from DB, evaluate transitions, persist via RPCs
 * - Lazy auto-transitions (checkAutoTransitions on every request)
 * - Join gate evaluation (8-step gate)
 * - Session creation + Daily.co token generation
 * - Cancel flow with Stripe refunds
 *
 * Gateway is stateless on Cloud Run — no in-memory state.
 * Every method loads current state from DB, acts, and persists.
 */

import { evaluateTransition } from './room-state-machine';
import { DailyClient } from './daily-client';
import { emitOasisEvent } from './oasis-event-service';
import type {
  RoomStatus,
  RoomMachineContext,
  RoomMachineEvent,
  CreateSessionPayload,
  JoinGateResult,
  RoomStateSnapshot,
  RoomCounts,
} from '../types/live-room';

// =============================================================================
// Types
// =============================================================================

interface RpcResult {
  ok: boolean;
  data?: any;
  error?: string;
  message?: string;
}

interface TransitionResult {
  ok: boolean;
  newStatus?: RoomStatus;
  error?: string;
  message?: string;
}

interface SessionCreateResult {
  ok: boolean;
  sessionId?: string;
  status?: string;
  roomId?: string;
  dailyRoomUrl?: string;
  idempotent?: boolean;
  error?: string;
  message?: string;
}

interface CancelResult {
  ok: boolean;
  refundTotal?: number;
  refundSucceeded?: number;
  refundFailed?: number;
  error?: string;
  message?: string;
}

// =============================================================================
// Supabase RPC Helper (shared with live.ts)
// =============================================================================

/**
 * Call a Supabase RPC function with the given token.
 * Uses service role key for apikey, and the user's JWT for Authorization.
 */
async function callRpc(
  token: string,
  functionName: string,
  params: Record<string, unknown>
): Promise<RpcResult> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Gateway misconfigured' };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
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
      const errorMessage = parsedError?.message || '';

      console.error(
        `[VTID-01228] RPC ${functionName} failed: HTTP ${response.status} | code=${errorCode} | message=${errorMessage} | hint=${errorHint} | body=${errorText}`
      );
      return { ok: false, error: `RPC failed: ${response.status}`, message: errorText };
    }

    const data = await response.json() as Record<string, unknown> | Array<any>;
    const result = Array.isArray(data) ? data[0] : data;

    if (result && typeof result === 'object' && result.ok === false) {
      return { ok: false, error: result.error as string, message: result.message as string };
    }

    return { ok: true, data: result };
  } catch (err: any) {
    console.error(`[VTID-01228] RPC ${functionName} exception: ${err.message}`, {
      function: functionName,
      stack: err.stack?.split('\n').slice(0, 3).join(' | '),
      cause: err.cause?.message,
    });
    return { ok: false, error: err.message };
  }
}

// =============================================================================
// Room Session Manager
// =============================================================================

export class RoomSessionManager {
  private dailyClient: DailyClient | null = null;

  constructor() {
    try {
      this.dailyClient = new DailyClient();
    } catch {
      // DAILY_API_KEY not set — Daily.co features disabled
      console.warn('[VTID-01228] DailyClient not available (DAILY_API_KEY missing)');
    }
  }

  // ===========================================================================
  // Session Creation ("Go Live")
  // ===========================================================================

  /**
   * Create a new session on a permanent room.
   * Host-only. Room must be idle.
   *
   * 1. Call live_room_create_session RPC (validates host, creates session)
   * 2. If first session, create permanent Daily.co room
   * 3. Generate per-session Daily.co meeting tokens
   * 4. Emit OASIS event
   */
  async createSession(
    roomId: string,
    payload: CreateSessionPayload,
    token: string
  ): Promise<SessionCreateResult> {
    // Run lazy auto-transitions first
    await this.checkAutoTransitions(roomId, token);

    const result = await callRpc(token, 'live_room_create_session', {
      p_room_id: roomId,
      p_payload: {
        session_title: payload.session_title || null,
        topic_keys: payload.topic_keys || [],
        starts_at: payload.starts_at,
        ends_at: payload.ends_at || null,
        access_level: payload.access_level || 'public',
        auto_admit: payload.auto_admit ?? true,
        lobby_buffer_minutes: payload.lobby_buffer_minutes ?? 15,
        max_participants: payload.max_participants ?? 100,
        metadata: payload.metadata || {},
        idempotency_key: payload.idempotency_key || null,
      }
    });

    if (!result.ok) {
      const finalError = result.data?.error || result.error;
      const finalMessage = result.data?.message || result.message;
      console.error(
        `[VTID-01228] createSession RPC failed: roomId=${roomId} | error=${finalError} | message=${finalMessage}`,
        { roomId, payload: { session_title: payload.session_title, starts_at: payload.starts_at, access_level: payload.access_level }, rpcResult: result }
      );
      return { ok: false, error: finalError, message: finalMessage };
    }

    const sessionData = result.data;
    let dailyRoomUrl: string | undefined;

    // Create or reuse Daily.co room (permanent per room)
    if (this.dailyClient) {
      try {
        const roomResult = await this.dailyClient.createRoom({
          roomId,
          title: payload.session_title || 'Vitana Live Room',
        });
        dailyRoomUrl = roomResult.roomUrl;

        // Persist Daily.co room info to database metadata
        const updateResult = await callRpc(token, 'live_room_update_metadata', {
          p_live_room_id: roomId,
          p_metadata: {
            daily_room_url: roomResult.roomUrl,
            daily_room_name: roomResult.roomName,
            video_provider: 'daily_co'
          }
        });

        if (!updateResult.ok) {
          console.error('[VTID-01228] Failed to update room metadata with Daily.co info:', updateResult.error);
        }
      } catch (err: any) {
        console.error('[VTID-01228] Daily.co room creation failed:', err.message);
        // Don't fail session creation — Daily.co is optional
      }
    }

    // Emit OASIS event
    await emitOasisEvent({
      vtid: 'VTID-01228',
      type: 'live.session.created' as any,
      source: 'room-session-manager',
      status: 'success',
      message: `Session created on room ${roomId}: ${sessionData.status}`,
      payload: {
        room_id: roomId,
        session_id: sessionData.session_id,
        status: sessionData.status,
        idempotent: sessionData.idempotent || false,
      }
    }).catch(err => console.warn('[VTID-01228] Failed to emit session.created:', err.message));

    return {
      ok: true,
      sessionId: sessionData.session_id,
      status: sessionData.status,
      roomId,
      dailyRoomUrl,
      idempotent: sessionData.idempotent || false,
    };
  }

  // ===========================================================================
  // State Transitions
  // ===========================================================================

  /**
   * Execute a state transition on a room.
   *
   * 1. Load room state from DB
   * 2. Enforce host authorization (Gateway-layer, not in XState)
   * 3. Evaluate transition with XState
   * 4. Persist via optimistic locking RPC
   * 5. Emit OASIS event
   */
  async transition(
    roomId: string,
    event: RoomMachineEvent,
    token: string
  ): Promise<TransitionResult> {
    // Load current room state
    const stateResult = await callRpc(token, 'live_room_get_state', {
      p_room_id: roomId,
    });

    if (!stateResult.ok || !stateResult.data?.room) {
      return { ok: false, error: stateResult.data?.error || 'ROOM_NOT_FOUND' };
    }

    const room = stateResult.data.room;
    const session = stateResult.data.session;
    const currentStatus = room.status as RoomStatus;

    // Host authorization check (Gateway-layer, NOT in XState machine)
    // TIMEOUT and RESET events don't have userId — they're system-initiated
    if ('userId' in event) {
      if (event.userId !== room.host_user_id) {
        return { ok: false, error: 'NOT_HOST', message: 'Only the room owner can perform this action' };
      }
    }

    // Build machine context
    const context: RoomMachineContext = {
      roomId,
      sessionId: room.current_session_id,
      hostUserId: room.host_user_id,
      startsAt: session?.starts_at || new Date().toISOString(),
      endsAt: session?.ends_at || null,
      maxParticipants: session?.max_participants || 100,
      autoAdmit: session?.auto_admit ?? true,
      lobbyBufferMinutes: session?.lobby_buffer_minutes ?? 15,
      accessLevel: session?.access_level || 'public',
    };

    // Evaluate transition with XState
    const newStatus = evaluateTransition(currentStatus, event, context);

    if (!newStatus) {
      return {
        ok: false,
        error: 'INVALID_TRANSITION',
        message: `Cannot transition from '${currentStatus}' with event '${event.type}'`,
      };
    }

    // Special handling for END — use live_room_end_session RPC (resets to idle)
    if (event.type === 'END' || event.type === 'TIMEOUT') {
      const endResult = await callRpc(token, 'live_room_end_session', {
        p_room_id: roomId,
      });

      if (!endResult.ok) {
        return { ok: false, error: endResult.data?.error || 'END_FAILED', message: endResult.data?.message };
      }

      // Invalidate session grants (no refunds on normal end)
      if (session?.id) {
        await callRpc(token, 'live_room_invalidate_session_grants', {
          p_session_id: session.id,
        });
      }

      await this.emitTransitionEvent(roomId, currentStatus, 'ended', event.type);
      return { ok: true, newStatus: 'ended' as RoomStatus };
    }

    // For all other transitions, use optimistic locking RPC
    const transitionResult = await callRpc(token, 'live_room_transition_status', {
      p_room_id: roomId,
      p_new_status: newStatus,
      p_expected_old_status: currentStatus,
    });

    if (!transitionResult.ok) {
      return {
        ok: false,
        error: transitionResult.data?.error || 'CONFLICT',
        message: transitionResult.data?.message || 'Room state already changed',
      };
    }

    await this.emitTransitionEvent(roomId, currentStatus, newStatus, event.type);
    return { ok: true, newStatus };
  }

  // ===========================================================================
  // Cancel Flow (with Stripe refunds)
  // ===========================================================================

  /**
   * Cancel the current session, refund paid grants, reset room to idle.
   *
   * 1. Transition to cancelled
   * 2. Fetch paid grants for this session
   * 3. Process refunds (Stripe)
   * 4. Invalidate remaining grants
   * 5. Reset room to idle
   */
  async cancelSession(
    roomId: string,
    userId: string,
    token: string,
    stripe?: any
  ): Promise<CancelResult> {
    // Get current state
    const stateResult = await callRpc(token, 'live_room_get_state', {
      p_room_id: roomId,
    });

    if (!stateResult.ok || !stateResult.data?.room) {
      return { ok: false, error: 'ROOM_NOT_FOUND' };
    }

    const room = stateResult.data.room;
    const session = stateResult.data.session;

    // Host check
    if (room.host_user_id !== userId) {
      return { ok: false, error: 'NOT_HOST' };
    }

    // Must have an active session
    if (!session || room.status === 'idle' || room.status === 'ended' || room.status === 'cancelled') {
      return { ok: false, error: 'NO_ACTIVE_SESSION' };
    }

    // Transition to cancelled via optimistic locking
    const cancelResult = await callRpc(token, 'live_room_transition_status', {
      p_room_id: roomId,
      p_new_status: 'cancelled',
      p_expected_old_status: room.status,
    });

    if (!cancelResult.ok) {
      return { ok: false, error: cancelResult.data?.error || 'CONFLICT' };
    }

    // Process refunds for paid grants
    let refundTotal = 0;
    let refundSucceeded = 0;
    let refundFailed = 0;

    if (stripe && session.id) {
      const serviceToken = process.env.SUPABASE_SERVICE_ROLE;
      if (serviceToken) {
        const grantsResult = await callRpc(serviceToken, 'live_room_get_paid_grants', {
          p_session_id: session.id,
        });

        if (grantsResult.ok && grantsResult.data?.grants) {
          const grants = grantsResult.data.grants;
          refundTotal = grants.length;

          for (const grant of grants) {
            if (!grant.stripe_payment_intent_id) continue;

            try {
              const refund = await stripe.refunds.create({
                payment_intent: grant.stripe_payment_intent_id,
              });

              await callRpc(serviceToken, 'live_room_update_grant_refund', {
                p_grant_id: grant.id,
                p_refund_status: 'succeeded',
                p_refund_id: refund.id,
              });
              refundSucceeded++;
            } catch (err: any) {
              console.error(`[VTID-01228] Refund failed for grant ${grant.id}:`, err.message);
              await callRpc(serviceToken, 'live_room_update_grant_refund', {
                p_grant_id: grant.id,
                p_refund_status: 'failed',
                p_refund_id: null,
              });
              refundFailed++;
            }
          }
        }
      }
    }

    // Invalidate remaining grants (free/granted)
    if (session.id) {
      await callRpc(token, 'live_room_invalidate_session_grants', {
        p_session_id: session.id,
      });
    }

    // End the session (set session status='cancelled', close attendance, reset room to idle)
    // Note: The room is already 'cancelled' from the transition above.
    // We need to also end the session and reset to idle.
    if (session.id) {
      // Update session status to cancelled
      // The transition RPC already set it, but let's also close attendance
      const serviceToken = process.env.SUPABASE_SERVICE_ROLE;
      if (serviceToken) {
        // Close all attendance for this session and reset room to idle
        const endResult = await callRpc(serviceToken, 'live_room_end_session', {
          p_room_id: roomId,
        });

        if (!endResult.ok) {
          console.error(
            `[VTID-01228] live_room_end_session failed after cancel: roomId=${roomId} | error=${endResult.error} | message=${endResult.message}. Attempting direct reset.`
          );

          // Fallback: directly reset the room to idle via transition RPC
          const resetResult = await callRpc(serviceToken, 'live_room_transition_status', {
            p_room_id: roomId,
            p_new_status: 'idle',
            p_expected_old_status: 'cancelled',
          });

          if (!resetResult.ok) {
            console.error(
              `[VTID-01228] Fallback reset to idle also failed: roomId=${roomId} | error=${resetResult.error}. Room may be stuck in 'cancelled' state.`
            );
          } else {
            // Also clear current_session_id since transition RPC doesn't do that
            await callRpc(serviceToken, 'live_room_update_metadata', {
              p_live_room_id: roomId,
              p_metadata: {},
            }).catch(() => {});
            console.log(`[VTID-01228] Fallback reset to idle succeeded: roomId=${roomId}`);
          }
        }
      }
    }

    // Emit events
    await emitOasisEvent({
      vtid: 'VTID-01228',
      type: 'live.room.cancelled' as any,
      source: 'room-session-manager',
      status: 'success',
      message: `Session cancelled on room ${roomId}`,
      payload: {
        room_id: roomId,
        session_id: session.id,
        refund_total: refundTotal,
        refund_succeeded: refundSucceeded,
        refund_failed: refundFailed,
      }
    }).catch(err => console.warn('[VTID-01228] Failed to emit room.cancelled:', err.message));

    if (refundFailed > 0) {
      await emitOasisEvent({
        vtid: 'VTID-01228',
        type: 'live.room.refund_failures' as any,
        source: 'room-session-manager',
        status: 'warning',
        message: `${refundFailed} refund(s) failed for session on room ${roomId}`,
        payload: {
          room_id: roomId,
          session_id: session.id,
          failed_count: refundFailed,
        }
      }).catch(err => console.warn('[VTID-01228] Failed to emit refund_failures:', err.message));
    }

    return {
      ok: true,
      refundTotal,
      refundSucceeded,
      refundFailed,
    };
  }

  // ===========================================================================
  // Lazy Auto-Transitions
  // ===========================================================================

  /**
   * Check and execute automatic transitions based on time conditions.
   * Called before every room API request (lazy evaluation).
   *
   * - scheduled → lobby: when NOW >= starts_at - lobby_buffer_minutes
   * - live → ended: when ends_at is set and NOW >= ends_at
   */
  async checkAutoTransitions(roomId: string, token: string): Promise<void> {
    try {
      const stateResult = await callRpc(token, 'live_room_get_state', {
        p_room_id: roomId,
      });

      if (!stateResult.ok || !stateResult.data?.room) return;

      const room = stateResult.data.room;
      const session = stateResult.data.session;
      if (!session) return;

      const now = Date.now();

      // scheduled → lobby: auto-open lobby when approaching start time
      if (room.status === 'scheduled') {
        const startsAt = new Date(session.starts_at).getTime();
        const bufferMs = (session.lobby_buffer_minutes || 15) * 60 * 1000;
        const lobbyOpenTime = startsAt - bufferMs;

        if (now >= lobbyOpenTime) {
          await callRpc(token, 'live_room_transition_status', {
            p_room_id: roomId,
            p_new_status: 'lobby',
            p_expected_old_status: 'scheduled',
          });
          console.log(`[VTID-01228] Auto-transition: room ${roomId} scheduled → lobby`);

          // VTID-01228: Sync to community_live_streams so stream becomes visible
          try {
            const supabaseUrl = process.env.SUPABASE_URL;
            const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;
            if (supabaseUrl && supabaseKey) {
              await fetch(`${supabaseUrl}/rest/v1/community_live_streams?id=eq.${roomId}`, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  'apikey': supabaseKey,
                  'Authorization': `Bearer ${supabaseKey}`,
                  'Prefer': 'return=minimal'
                },
                body: JSON.stringify({
                  status: 'live',
                  started_at: new Date().toISOString()
                })
              });
              console.log(`[VTID-01228] Auto-transition sync: community_live_streams updated to 'live' for room ${roomId}`);
            }
          } catch (err: any) {
            console.warn(`[VTID-01228] Auto-transition sync failed: ${err.message}`);
          }
        }
      }

      // live → ended: auto-end when past ends_at
      if (room.status === 'live' && session.ends_at) {
        const endsAt = new Date(session.ends_at).getTime();

        if (now >= endsAt) {
          await callRpc(token, 'live_room_end_session', {
            p_room_id: roomId,
          });
          console.log(`[VTID-01228] Auto-transition: room ${roomId} live → ended (timeout)`);
        }
      }

      // cancelled/ended → idle: auto-heal stuck rooms
      if (room.status === 'cancelled' || room.status === 'ended') {
        const endResult = await callRpc(token, 'live_room_end_session', {
          p_room_id: roomId,
        });
        if (endResult.ok) {
          console.log(`[VTID-01228] Auto-heal: room ${roomId} ${room.status} → idle`);
        } else {
          console.warn(`[VTID-01228] Auto-heal failed for room ${roomId} (${room.status}): ${endResult.error}`);
        }
      }
    } catch (err: any) {
      // Auto-transitions are best-effort; don't block the request
      console.warn('[VTID-01228] Auto-transition check failed:', err.message);
    }
  }

  // ===========================================================================
  // Room State Snapshot
  // ===========================================================================

  /**
   * Get the full state snapshot for a room (room + session + counts + viewer).
   * Single endpoint that returns everything the frontend needs.
   */
  async getState(
    roomId: string,
    token: string
  ): Promise<RpcResult> {
    // Run lazy auto-transitions first
    await this.checkAutoTransitions(roomId, token);

    return callRpc(token, 'live_room_get_state', {
      p_room_id: roomId,
    });
  }

  // ===========================================================================
  // Host Presence
  // ===========================================================================

  async setHostPresent(roomId: string, present: boolean, token: string): Promise<RpcResult> {
    return callRpc(token, 'live_room_set_host_present', {
      p_room_id: roomId,
      p_present: present,
    });
  }

  // ===========================================================================
  // Lobby Management
  // ===========================================================================

  async getLobby(roomId: string, token: string): Promise<RpcResult> {
    return callRpc(token, 'live_room_get_lobby', {
      p_room_id: roomId,
    });
  }

  async admitUser(roomId: string, userId: string, token: string): Promise<RpcResult> {
    return callRpc(token, 'live_room_admit_user', {
      p_room_id: roomId,
      p_user_id: userId,
    });
  }

  async rejectUser(roomId: string, userId: string, token: string): Promise<RpcResult> {
    return callRpc(token, 'live_room_reject_user', {
      p_room_id: roomId,
      p_user_id: userId,
    });
  }

  async admitAll(roomId: string, token: string): Promise<RpcResult> {
    return callRpc(token, 'live_room_admit_all', {
      p_room_id: roomId,
    });
  }

  // ===========================================================================
  // Kick / Ban / Disconnect
  // ===========================================================================

  async kickUser(roomId: string, userId: string, token: string): Promise<RpcResult> {
    return callRpc(token, 'live_room_kick_user', {
      p_room_id: roomId,
      p_user_id: userId,
    });
  }

  async banUser(roomId: string, userId: string, token: string): Promise<RpcResult> {
    return callRpc(token, 'live_room_ban_user', {
      p_room_id: roomId,
      p_user_id: userId,
    });
  }

  async disconnect(roomId: string, token: string): Promise<RpcResult> {
    return callRpc(token, 'live_room_disconnect', {
      p_room_id: roomId,
    });
  }

  // ===========================================================================
  // Join Session
  // ===========================================================================

  /**
   * Join a live room session.
   * Calls the DB-level RPC which handles the full 8-step join gate.
   */
  async joinSession(roomId: string, sessionId: string, token: string): Promise<RpcResult> {
    // Run lazy auto-transitions first
    await this.checkAutoTransitions(roomId, token);

    return callRpc(token, 'live_room_join_session', {
      p_room_id: roomId,
      p_session_id: sessionId,
    });
  }

  // ===========================================================================
  // Session History
  // ===========================================================================

  async getSessions(roomId: string, token: string): Promise<RpcResult> {
    return callRpc(token, 'live_room_get_sessions', {
      p_room_id: roomId,
    });
  }

  // ===========================================================================
  // Room Identity Updates
  // ===========================================================================

  async updateRoomIdentity(
    roomId: string,
    updates: { name?: string; slug?: string; coverImageUrl?: string; description?: string },
    token: string
  ): Promise<RpcResult> {
    return callRpc(token, 'live_room_update_room_name', {
      p_room_id: roomId,
      p_name: updates.name || null,
      p_slug: updates.slug || null,
      p_cover_image_url: updates.coverImageUrl || null,
      p_description: updates.description || null,
    });
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private async emitTransitionEvent(
    roomId: string,
    fromStatus: RoomStatus,
    toStatus: RoomStatus,
    eventType: string
  ): Promise<void> {
    await emitOasisEvent({
      vtid: 'VTID-01228',
      type: `live.room.${toStatus}` as any,
      source: 'room-session-manager',
      status: 'success',
      message: `Room ${roomId}: ${fromStatus} → ${toStatus} (${eventType})`,
      payload: {
        room_id: roomId,
        from_status: fromStatus,
        to_status: toStatus,
        event_type: eventType,
      }
    }).catch(err => console.warn(`[VTID-01228] Failed to emit transition event:`, err.message));
  }
}
