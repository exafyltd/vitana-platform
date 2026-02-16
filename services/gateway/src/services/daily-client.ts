/**
 * VTID-01228: Daily.co API Client for Live Rooms
 *
 * Simple REST API client for creating and managing Daily.co video rooms.
 * Uses Bearer token authentication - no complex OAuth or service account setup.
 */

export interface DailyRoomDetails {
  roomId: string;
  title: string;
  expiresInHours?: number; // Default: 24 hours
}

export interface DailyRoomResult {
  roomUrl: string;   // Full Daily.co room URL
  roomName: string;  // Room name (for idempotency and deletion)
}

export interface DailyMeetingTokenDetails {
  roomName: string;       // Daily.co room name (e.g., "vitana-XXXXX")
  expiresAt: number;      // Unix timestamp (seconds) when token expires
  isOwner?: boolean;      // true for host, false for guest (default: false)
  userName?: string;      // Display name in the call
}

export interface DailyMeetingTokenResult {
  token: string;          // JWT meeting token
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
   * Create a Daily.co video room
   *
   * Features:
   * - Idempotent: Same roomId creates/returns same room
   * - Auto-expiration: Default 24 hours
   * - Configurable: Enable chat, screenshare, recording
   *
   * @param details Room details including ID and title
   * @returns Room URL and name
   */
  async createRoom(details: DailyRoomDetails): Promise<DailyRoomResult> {
    const { roomId, title, expiresInHours = 24 } = details;
    const roomName = `vitana-${roomId}`;

    // Calculate expiration timestamp (Unix seconds)
    const exp = Math.floor(Date.now() / 1000) + (expiresInHours * 3600);

    const response = await fetch(`${this.apiBase}/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        name: roomName,
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
      return { roomUrl: data.url, roomName: data.name };
    }

    // Room already exists — fetch existing room info instead of failing
    if (response.status === 400) {
      console.log(`[VTID-01228] Daily.co room may already exist, fetching: ${roomName}`);
      const existing = await this.getRoomInfo(roomName);
      if (existing) {
        return { roomUrl: existing.url, roomName: existing.name };
      }
    }

    const error = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(`Daily.co API error: ${error.error || response.statusText}`);
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
   * Create a per-session meeting token for Daily.co
   *
   * Meeting tokens control access to a room. Each token has an expiration
   * and an isOwner flag. Leaked room URLs without a valid token cannot join.
   *
   * @param details Token details (room name, expiration, owner flag)
   * @returns Meeting token JWT
   */
  async createMeetingToken(details: DailyMeetingTokenDetails): Promise<DailyMeetingTokenResult> {
    const { roomName, expiresAt, isOwner = false, userName } = details;

    const properties: Record<string, unknown> = {
      room_name: roomName,
      exp: expiresAt,
      is_owner: isOwner,
    };

    if (userName) {
      properties.user_name = userName;
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
