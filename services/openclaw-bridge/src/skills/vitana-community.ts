/**
 * Vitana Community Skill for OpenClaw
 *
 * Manages community groups, meetups, memberships,
 * invitations, and recommendation-based matching.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CreateGroupSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  topic_key: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  is_public: z.boolean().default(true),
});

const JoinGroupSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  group_id: z.string().uuid(),
});

const InviteUserSchema = z.object({
  tenant_id: z.string().uuid(),
  inviter_id: z.string().uuid(),
  invitee_id: z.string().uuid(),
  group_id: z.string().uuid(),
});

const InvitationActionSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  invitation_id: z.string().uuid(),
});

const CreateMeetupSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  group_id: z.string().uuid(),
  title: z.string().min(1).max(255),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime(),
  mode: z.enum(['online', 'in_person', 'hybrid']).default('online'),
  description: z.string().max(2000).optional(),
});

const RecommendationsSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  date: z.string().optional(),
  type: z.string().max(50).optional(),
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

async function callGateway(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<unknown> {
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
  const res = await fetch(`${gatewayUrl}/api/v1/community${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Community endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Create a new community group.
   */
  async create_group(input: unknown) {
    const { tenant_id, user_id, name, topic_key, description, is_public } =
      CreateGroupSchema.parse(input);

    const data = await callGateway('/groups', 'POST', {
      tenant_id,
      user_id,
      name,
      topic_key,
      description,
      is_public,
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'community.group_created',
      actor: 'openclaw-autopilot',
      details: { user_id, name, topic_key },
      created_at: new Date().toISOString(),
    });

    return { success: true, group: data };
  },

  /**
   * Join a community group.
   */
  async join_group(input: unknown) {
    const { tenant_id, user_id, group_id } = JoinGroupSchema.parse(input);

    const data = await callGateway(`/groups/${group_id}/join`, 'POST', {
      tenant_id,
      user_id,
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'community.group_joined',
      actor: 'openclaw-autopilot',
      details: { user_id, group_id },
      created_at: new Date().toISOString(),
    });

    return { success: true, membership: data };
  },

  /**
   * Invite a user to a community group.
   */
  async invite_user(input: unknown) {
    const { tenant_id, inviter_id, invitee_id, group_id } = InviteUserSchema.parse(input);

    const data = await callGateway(`/groups/${group_id}/invite`, 'POST', {
      tenant_id,
      inviter_id,
      invitee_id,
    });

    return { success: true, invitation: data };
  },

  /**
   * Accept a group invitation.
   */
  async accept_invitation(input: unknown) {
    const { tenant_id, user_id, invitation_id } = InvitationActionSchema.parse(input);

    const data = await callGateway(`/invitations/${invitation_id}/accept`, 'POST', {
      tenant_id,
      user_id,
    });

    return { success: true, result: data };
  },

  /**
   * Decline a group invitation.
   */
  async decline_invitation(input: unknown) {
    const { tenant_id, user_id, invitation_id } = InvitationActionSchema.parse(input);

    const data = await callGateway(`/invitations/${invitation_id}/decline`, 'POST', {
      tenant_id,
      user_id,
    });

    return { success: true, result: data };
  },

  /**
   * Create a community meetup within a group.
   */
  async create_meetup(input: unknown) {
    const { tenant_id, user_id, group_id, title, starts_at, ends_at, mode, description } =
      CreateMeetupSchema.parse(input);

    const data = await callGateway('/meetups', 'POST', {
      tenant_id,
      user_id,
      group_id,
      title,
      starts_at,
      ends_at,
      mode,
      description,
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'community.meetup_created',
      actor: 'openclaw-autopilot',
      details: { user_id, group_id, title, mode },
      created_at: new Date().toISOString(),
    });

    return { success: true, meetup: data };
  },

  /**
   * Get community recommendations for a user.
   */
  async get_recommendations(input: unknown) {
    const { tenant_id, user_id, date, type } = RecommendationsSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);
    if (date) params.set('date', date);
    if (type) params.set('type', type);

    const data = await callGateway(`/recommendations?${params.toString()}`, 'GET');
    return { success: true, recommendations: data };
  },

  /**
   * Recompute community recommendations for a user.
   */
  async recompute_recommendations(input: unknown) {
    const { tenant_id, user_id } = z.object({
      tenant_id: z.string().uuid(),
      user_id: z.string().uuid(),
    }).parse(input);

    const data = await callGateway('/recommendations/recompute', 'POST', {
      tenant_id,
      user_id,
    });

    return { success: true, result: data };
  },
};

export const SKILL_META = {
  name: 'vitana-community',
  description: 'Community groups, meetups, invitations, memberships, and recommendation matching',
  actions: Object.keys(actions),
};
