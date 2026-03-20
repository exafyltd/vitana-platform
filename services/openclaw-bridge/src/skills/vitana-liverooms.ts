/**
 * Vitana Live Rooms Skill for OpenClaw
 *
 * Full live room lifecycle: creation, session management,
 * lobby control, highlights, and Daily.co room provisioning.
 * Extends vitana-daily with session management capabilities.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CreateRoomSchema = z.object({
  tenant_id: z.string().uuid(),
  host_id: z.string().uuid(),
  title: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  scheduled_at: z.string().datetime().optional(),
  duration_minutes: z.number().int().min(5).max(480).default(60),
  is_paid: z.boolean().default(false),
  price_cents: z.number().int().min(0).optional(),
});

const RoomActionSchema = z.object({
  tenant_id: z.string().uuid(),
  room_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

const AddHighlightSchema = z.object({
  tenant_id: z.string().uuid(),
  room_id: z.string().uuid(),
  user_id: z.string().uuid(),
  title: z.string().min(1).max(255),
  timestamp_seconds: z.number().int().min(0),
  notes: z.string().max(2000).optional(),
});

const RoomSummarySchema = z.object({
  tenant_id: z.string().uuid(),
  room_id: z.string().uuid(),
});

const ProvisionDailySchema = z.object({
  tenant_id: z.string().uuid(),
  room_id: z.string().uuid(),
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

async function callGateway(path: string, method: 'GET' | 'POST' | 'DELETE', body?: Record<string, unknown>): Promise<unknown> {
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
  const res = await fetch(`${gatewayUrl}/api/v1/live${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Live rooms endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Create a new live room.
   */
  async create_room(input: unknown) {
    const { tenant_id, host_id, title, description, scheduled_at, duration_minutes, is_paid, price_cents } =
      CreateRoomSchema.parse(input);

    const data = await callGateway('/rooms', 'POST', {
      tenant_id,
      host_id,
      title,
      description,
      scheduled_at,
      duration_minutes,
      is_paid,
      price_cents,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'liverooms.room_created',
      actor: 'openclaw-autopilot',
      details: { host_id, title, is_paid },
      created_at: new Date().toISOString(),
    });

    return { success: true, room: data };
  },

  /**
   * Start a live room session.
   */
  async start_room(input: unknown) {
    const { tenant_id, room_id, user_id } = RoomActionSchema.parse(input);

    const data = await callGateway(`/rooms/${room_id}/start`, 'POST', {
      tenant_id,
      user_id,
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'liverooms.room_started',
      actor: 'openclaw-autopilot',
      details: { room_id, user_id },
      created_at: new Date().toISOString(),
    });

    return { success: true, session: data };
  },

  /**
   * End a live room session.
   */
  async end_room(input: unknown) {
    const { tenant_id, room_id, user_id } = RoomActionSchema.parse(input);

    const data = await callGateway(`/rooms/${room_id}/end`, 'POST', {
      tenant_id,
      user_id,
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'liverooms.room_ended',
      actor: 'openclaw-autopilot',
      details: { room_id, user_id },
      created_at: new Date().toISOString(),
    });

    return { success: true, result: data };
  },

  /**
   * Join a live room.
   */
  async join_room(input: unknown) {
    const { tenant_id, room_id, user_id } = RoomActionSchema.parse(input);

    const data = await callGateway(`/rooms/${room_id}/join`, 'POST', {
      tenant_id,
      user_id,
    });

    return { success: true, result: data };
  },

  /**
   * Leave a live room.
   */
  async leave_room(input: unknown) {
    const { tenant_id, room_id, user_id } = RoomActionSchema.parse(input);

    const data = await callGateway(`/rooms/${room_id}/leave`, 'POST', {
      tenant_id,
      user_id,
    });

    return { success: true, result: data };
  },

  /**
   * Add a highlight/clip to a live room.
   */
  async add_highlight(input: unknown) {
    const { tenant_id, room_id, user_id, title, timestamp_seconds, notes } =
      AddHighlightSchema.parse(input);

    const data = await callGateway(`/rooms/${room_id}/highlights`, 'POST', {
      tenant_id,
      user_id,
      title,
      timestamp_seconds,
      notes,
    });

    return { success: true, highlight: data };
  },

  /**
   * Get a room summary including participants and highlights.
   */
  async get_summary(input: unknown) {
    const { tenant_id, room_id } = RoomSummarySchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);

    const data = await callGateway(`/rooms/${room_id}/summary?${params.toString()}`, 'GET');
    return { success: true, summary: data };
  },

  /**
   * Provision a Daily.co room for a live room.
   */
  async provision_daily(input: unknown) {
    const { tenant_id, room_id } = ProvisionDailySchema.parse(input);

    const data = await callGateway(`/rooms/${room_id}/daily`, 'POST', {
      tenant_id,
      source: 'openclaw-autopilot',
    });

    return { success: true, daily_room: data };
  },
};

export const SKILL_META = {
  name: 'vitana-liverooms',
  description: 'Live room lifecycle: creation, session management, highlights, and Daily.co provisioning',
  actions: Object.keys(actions),
};
