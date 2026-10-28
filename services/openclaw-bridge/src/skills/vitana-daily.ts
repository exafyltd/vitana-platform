/**
 * Vitana Daily.co Skill for OpenClaw
 *
 * Manages live room scheduling and participant notifications
 * through Daily.co (or LiveKit as future alternative).
 *
 * Integrates with Vitana's existing live_rooms and events tables.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ScheduleRoomSchema = z.object({
  tenant_id: z.string().uuid(),
  datetime: z.string().datetime(),
  topic: z.string().min(1).max(500).optional(),
  participant_ids: z.array(z.string().uuid()).min(1).max(20),
  duration_minutes: z.number().int().min(5).max(180).default(60),
});

const SendReminderSchema = z.object({
  tenant_id: z.string().uuid(),
  room_id: z.string().uuid(),
  minutes_before: z.number().int().min(1).max(1440).default(15),
});

const ListUpcomingSchema = z.object({
  tenant_id: z.string().uuid(),
  hours_ahead: z.number().int().min(1).max(168).default(24),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE required');
  return createClient(url, key);
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Schedule a new live room session via the gateway's live rooms API.
   */
  async schedule_room(input: unknown) {
    const { tenant_id, datetime, topic, participant_ids, duration_minutes } =
      ScheduleRoomSchema.parse(input);

    const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
    const res = await fetch(`${gatewayUrl}/api/v1/live-rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id,
        scheduled_at: datetime,
        topic: topic ?? 'Vitana Session',
        participant_ids,
        duration_minutes,
        source: 'openclaw-autopilot',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`schedule_room failed (${res.status}): ${text}`);
    }

    const room = await res.json();

    // Audit
    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'daily.room_scheduled',
      actor: 'openclaw-autopilot',
      details: { room_id: room.id, datetime, participant_count: participant_ids.length },
      created_at: new Date().toISOString(),
    });

    return { success: true, room };
  },

  /**
   * Send reminders for an upcoming room to all participants.
   * Delegates to the notification service.
   */
  async send_reminder(input: unknown) {
    const { tenant_id, room_id, minutes_before } = SendReminderSchema.parse(input);

    const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
    const res = await fetch(`${gatewayUrl}/api/v1/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id,
        type: 'live_room_reminder',
        reference_id: room_id,
        metadata: { minutes_before },
        source: 'openclaw-autopilot',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`send_reminder failed (${res.status}): ${text}`);
    }

    return { success: true, room_id, minutes_before };
  },

  /**
   * List upcoming rooms for a tenant (used by heartbeat).
   */
  async list_upcoming(input: unknown) {
    const { tenant_id, hours_ahead } = ListUpcomingSchema.parse(input);
    const supabase = getSupabase();

    const cutoff = new Date(Date.now() + hours_ahead * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('live_rooms')
      .select('id, scheduled_at, topic, status')
      .eq('tenant_id', tenant_id)
      .gte('scheduled_at', new Date().toISOString())
      .lte('scheduled_at', cutoff)
      .order('scheduled_at', { ascending: true })
      .limit(50);

    if (error) throw new Error(`list_upcoming failed: ${error.message}`);
    return { success: true, rooms: data, count: data?.length ?? 0 };
  },
};

export const SKILL_META = {
  name: 'vitana-daily',
  description: 'Live room scheduling and reminders via Daily.co integration',
  actions: Object.keys(actions),
};
