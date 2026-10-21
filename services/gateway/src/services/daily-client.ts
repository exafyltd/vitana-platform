/**
 * VTID-01228: Daily.co API Client for Live Rooms
 * VTID-04904: private rooms + meeting tokens; room expiry follows the session
 *
 * Simple REST API client for creating and managing Daily.co video rooms.
 * Uses Bearer token authentication - no complex OAuth or service account setup.
 */

export interface DailyRoomResult {
  roomUrl: string;   // Full Daily.co room URL
  roomName: string;  // Room name (for idempotency and deletion)
  exp: number;       // Unix seconds the Daily room expires at (VTID-04904)
}

export interface DailyEnsureRoomOptions {
  expiresAt: number;      // Unix seconds — see computeDailyRoomExpiry()
}

export interface DailyMeetingTokenOptions {
  userId?: string;        // Vitana user id, shown to Daily as user_id
  userName?: string;      // Display name in the call
  isOwner?: boolean;      // true for the host (owner token), false for viewers
  exp: number;            // Unix seconds when the token expires
}

export interface DailyMeetingTokenResult {
  token: string;          // JWT meeting token
}

/** Daily room name for a permanent Vitana live room. */
export function dailyRoomNameFor(roomId: string): string {
  return `vitana-${roomId}`;
}

const HOUR_S = 3600;

/**
 * VTID-04904: when a Daily room (and its meeting tokens) should expire.
 *
 * `ends_at` if the session has one, else `starts_at + duration_minutes`
 * (default 60), plus a 2 h grace; never earlier than now + 4 h. A room
 * created for a session scheduled days ahead therefore stays joinable for
 * that session, and a room reused for a later session gets its `exp`
 * pushed out again by ensureRoom() (B3: rooms used to keep the 24 h `exp`
 * of their first session forever).
 */
export function computeDailyRoomExpiry(input: {
  startsAt?: string | null;
  endsAt?: string | null;
  durationMinutes?: number | null;
  nowMs?: number;
}): number {
  const nowS = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const floor = nowS + 4 * HOUR_S;

  let baseS: number | null = null;
  const endsMs = input.endsAt ? Date.parse(input.endsAt) : NaN;
  if (Number.isFinite(endsMs)) {
    baseS = Math.floor(endsMs / 1000);
  } else {
    const startsMs = input.startsAt ? Date.parse(input.startsAt) : NaN;
    if (Number.isFinite(startsMs)) {
      const d = Number(input.durationMinutes);
      const minutes = Number.isFinite(d) && d > 0 ? d : 60;
      baseS = Math.floor(startsMs / 1000) + Math.round(minutes * 60);
    }
  }

  if (baseS === null) return floor;
  return Math.max(baseS + 2 * HOUR_S, floor);
}

export class DailyClient {
  private apiKey: string;
  private apiBase = 'https://api.daily.co/v1';

  constructor() {
    this.apiKey = process.env.DAILY_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('DAILY_API_KEY environment variable is required');
    }
  }

  /**
   * VTID-04904: create the room, or bring an existing one up to date.
   *
   * - Rooms are PRIVATE: nobody joins with the bare URL, only with a meeting
   *   token issued by the gateway (createMeetingToken).
   * - Idempotent per live room (`vitana-<roomId>`). When the room already
   *   exists, its `exp` and `privacy` are updated (POST /rooms/:name) instead
   *   of returning the stale room as-is.
   */
  async ensureRoom(roomId: string, options: DailyEnsureRoomOptions): Promise<DailyRoomResult> {
    const roomName = dailyRoomNameFor(roomId);
    const exp = options.expiresAt;

    const response = await fetch(`${this.apiBase}/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        name: roomName,
        privacy: 'private',
        properties: {
          exp,
          enable_chat: true,
          enable_screenshare: true,
          enable_recording: 'cloud',
          start_video_off: false,
          start_audio_off: false,
          max_participants: 100
        }
      })
    });

    if (response.ok) {
      const data = await response.json() as { url: string; name: string };
      return { roomUrl: data.url, roomName: data.name, exp };
    }

    // 400 = the room already exists (one permanent room per live room):
    // refresh its expiry and make sure it is private.
    if (response.status === 400) {
      console.log(`[VTID-04904] Daily.co room exists, updating exp/privacy: ${roomName}`);
      const update = await fetch(`${this.apiBase}/rooms/${roomName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ privacy: 'private', properties: { exp } })
      });
      if (update.ok) {
        const data = await update.json() as { url: string; name: string };
        return { roomUrl: data.url, roomName: data.name || roomName, exp };
      }
      const updErr = await update.json().catch(() => ({ error: update.statusText })) as { error?: string; info?: string };
      throw new Error(`Daily.co update room error: ${updErr.info || updErr.error || update.statusText}`);
    }

    const error = await response.json().catch(() => ({ error: response.statusText })) as { error?: string; info?: string };
    throw new Error(`Daily.co API error: ${error.info || error.error || response.statusText}`);
  }

  /**
   * Delete a Daily.co room
   *
   * @param roomName The name of the room to delete
   */
  async deleteRoom(roomName: string): Promise<void> {
    const response = await fetch(`${this.apiBase}/rooms/${roomName}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`
      }
    });

    // 404 is OK - room already deleted
    if (!response.ok && response.status !== 404) {
      const error = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(`Daily.co delete error: ${error.error || response.statusText}`);
    }
  }

  /**
   * Get information about a Daily.co room
   *
   * @param roomName The name of the room
   * @returns Room info or null if not found
   */
  async getRoomInfo(roomName: string): Promise<any> {
    const response = await fetch(`${this.apiBase}/rooms/${roomName}`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      const error = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(`Daily.co get room error: ${error.error || response.statusText}`);
    }

    return response.json() as Promise<any>;
  }

  /**
   * Create a meeting token for one member and one room.
   *
   * VTID-04904: the only way into a private room. The host gets an owner
   * token (`is_owner: true`), everyone else a participant token. Tokens
   * expire with the room.
   */
  async createMeetingToken(roomName: string, options: DailyMeetingTokenOptions): Promise<DailyMeetingTokenResult> {
    const properties: Record<string, unknown> = {
      room_name: roomName,
      exp: options.exp,
      is_owner: options.isOwner === true,
    };

    if (options.userName) {
      properties.user_name = options.userName;
    }
    if (options.userId) {
      properties.user_id = options.userId;
    }

    const response = await fetch(`${this.apiBase}/meeting-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ properties })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(`Daily.co meeting token error: ${error.error || response.statusText}`);
    }

    const data = await response.json() as { token: string };

    return { token: data.token };
  }
}
