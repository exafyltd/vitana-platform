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

    // Calculate expiration timestamp (Unix seconds)
    const exp = Math.floor(Date.now() / 1000) + (expiresInHours * 3600);

    const response = await fetch(`${this.apiBase}/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        name: `vitana-${roomId}`,  // Room name (idempotency key)
        properties: {
          exp,  // Expiration timestamp
          enable_chat: true,
          enable_screenshare: true,
          enable_recording: 'cloud',  // Optional: enable recording
          start_video_off: false,
          start_audio_off: false,
          max_participants: 100  // Adjust as needed
        }
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(`Daily.co API error: ${error.error || response.statusText}`);
    }

    const data = await response.json() as { url: string; name: string };

    return {
      roomUrl: data.url,      // Full room URL (e.g., https://vitana.daily.co/vitana-XXXXX)
      roomName: data.name     // Room name (e.g., vitana-XXXXX)
    };
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
}
